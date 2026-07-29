<?php
/**
 * submit-test-report.php
 *
 * Receives one external test report from test-report.html.
 *
 * The report arrives as a single self-contained HTML file with the tester's
 * screenshots already embedded and downscaled by the browser, so this endpoint
 * handles exactly one upload rather than an unknown number of images.
 *
 * Three things drive the shape of this file.
 *
 * The upload is attacker-controlled HTML. Anyone can POST here, and stored
 * HTML that the web server will later hand back is a stored-XSS hole aimed at
 * whoever opens it, which is the maintainer. Reports are therefore written
 * OUTSIDE the document root, and nothing in this file ever serves one back.
 * The .htaccess written alongside them is a second line of defence for the
 * case where a host makes the parent directory reachable anyway.
 *
 * Nothing the tester typed is echoed into the response or into a mail header.
 * The reply is a fixed JSON string and the notification mail has a fixed
 * subject, sender and body, carrying only the stored filename. A submitted
 * address in a From: or Subject: is a header-injection relay.
 *
 * A public endpoint that writes files needs a ceiling. There is a byte cap, a
 * per-address hourly cap, and a honeypot field, so filling the disk takes
 * deliberate effort rather than one loop.
 *
 * Targets PHP 7.4, which is what the host runs. Nothing here needs a newer
 * language: no `never`, no `match`, no nullsafe operator, no named arguments.
 * Keep it that way, because the failure mode is a parse error that takes the
 * whole endpoint down rather than a warning anyone would notice in testing.
 */

declare(strict_types=1);

// ── Maintainer settings ─────────────────────────────────────────────────────

/** Where reports are written. MUST NOT be reachable over HTTP. */
const STORAGE_DIR = __DIR__ . '/../olv-test-reports';

/** Notification address. Leave empty to store silently without mailing. */
const NOTIFY_EMAIL = 'info@aurtech.mx';

/** Largest accepted report. Roughly six 1600px screenshots once base64'd. */
const MAX_BYTES = 12 * 1024 * 1024;

/** Reports accepted per address per hour. */
const MAX_PER_HOUR = 5;

// ── Response helper ─────────────────────────────────────────────────────────

/**
 * Always JSON, always a fixed message. `$log` is written to the server error
 * log instead of the body, because the difference between "directory missing"
 * and "directory not writable" is useful to the maintainer and useful to an
 * attacker mapping the filesystem.
 */
function reply(int $status, bool $ok, string $message, string $log = ''): void
{
    if ($log !== '') {
        error_log('[olv-test-report] ' . $log);
    }
    http_response_code($status);
    header('Content-Type: application/json; charset=utf-8');
    header('Cache-Control: no-store');
    echo json_encode(['ok' => $ok, 'message' => $message], JSON_UNESCAPED_SLASHES);
    exit;
}

// ── Method and size ─────────────────────────────────────────────────────────

if (($_SERVER['REQUEST_METHOD'] ?? '') !== 'POST') {
    header('Allow: POST');
    reply(405, false, 'This address only accepts submitted reports.');
}

$declared = (int) ($_SERVER['CONTENT_LENGTH'] ?? 0);
if ($declared > MAX_BYTES) {
    reply(413, false, 'That report is too large. Remove a screenshot and try again.');
}

// An oversized body can also blow PHP's own post_max_size, which empties $_POST
// and $_FILES rather than raising anything. Catching it here gives the tester a
// sentence they can act on instead of a bare failure.
if ($declared > 0 && $_POST === [] && $_FILES === []) {
    reply(413, false, 'That report is too large for this server. Remove a screenshot and try again.');
}

// ── Honeypot ────────────────────────────────────────────────────────────────

// A field hidden from people. A human never fills it; naive bots fill every
// input they find. Answering 200 keeps the bot from learning it was caught.
if (($_POST['website'] ?? '') !== '') {
    reply(200, true, 'Report received. Thank you.');
}

// ── Rate limit ──────────────────────────────────────────────────────────────

/**
 * One counter file per address per hour, named by hash so the directory does
 * not become a list of visitors' IPs. Shared hosting rarely has a cache to
 * lean on, so this is deliberately filesystem-only.
 */
function rateFile(string $dir): string
{
    $addr = $_SERVER['REMOTE_ADDR'] ?? 'unknown';
    return $dir . '/.rate-' . hash('sha256', $addr . gmdate('Y-m-d-H'));
}

function withinRateLimit(string $dir): bool
{
    $file = rateFile($dir);
    return (is_readable($file) ? (int) file_get_contents($file) : 0) < MAX_PER_HOUR;
}

/**
 * Counted after the report is safely on disk, never before.
 *
 * Charging the attempt would mean a tester whose upload keeps failing (a report
 * over the cap, a dropped connection) spends the whole hourly allowance on
 * submissions that were never stored, and is then locked out of the one that
 * would have worked. The limit exists to bound what gets written, so it counts
 * what actually got written.
 */
function countSubmission(string $dir): void
{
    $file = rateFile($dir);
    $count = is_readable($file) ? (int) file_get_contents($file) : 0;
    file_put_contents($file, (string) ($count + 1), LOCK_EX);
}

/** Delete counters and their hour is over. Cheap, and keeps the dir small. */
function sweepRateFiles(string $dir): void
{
    foreach (glob($dir . '/.rate-*') ?: [] as $f) {
        if (filemtime($f) < time() - 7200) {
            @unlink($f);
        }
    }
}

// ── Storage ─────────────────────────────────────────────────────────────────

$dir = STORAGE_DIR;
if (!is_dir($dir) && !@mkdir($dir, 0750, true) && !is_dir($dir)) {
    reply(500, false, 'The server could not accept the report. Please email it instead.', 'mkdir failed: ' . $dir);
}
if (!is_writable($dir)) {
    reply(500, false, 'The server could not accept the report. Please email it instead.', 'not writable: ' . $dir);
}

// Belt and braces: if this directory ever ends up inside the document root,
// these deny both Apache generations rather than silently serving reports.
$deny = $dir . '/.htaccess';
if (!file_exists($deny)) {
    @file_put_contents($deny, "Require all denied\n<IfModule !mod_authz_core.c>\nDeny from all\n</IfModule>\n");
}

sweepRateFiles($dir);
if (!withinRateLimit($dir)) {
    reply(429, false, 'Several reports have already come from this connection. Please try again later.');
}

// ── The upload ──────────────────────────────────────────────────────────────

$file = $_FILES['report'] ?? null;
if (!is_array($file) || ($file['error'] ?? UPLOAD_ERR_NO_FILE) !== UPLOAD_ERR_OK) {
    reply(400, false, 'No report arrived. Generate the report first, then send.');
}
if (!is_uploaded_file($file['tmp_name'])) {
    reply(400, false, 'That upload could not be read.', 'is_uploaded_file false');
}
if ($file['size'] <= 0 || $file['size'] > MAX_BYTES) {
    reply(413, false, 'That report is empty or too large.');
}

// The tester's filename is never used. It is attacker-controlled and only ever
// causes trouble; a random name cannot traverse, collide, or carry a second
// extension that some server configuration decides to execute.
$name = gmdate('Y-m-d-His') . '-' . bin2hex(random_bytes(6)) . '.report.html';
$target = $dir . '/' . $name;

if (!move_uploaded_file($file['tmp_name'], $target)) {
    reply(500, false, 'The report could not be saved. Please email it instead.', 'move_uploaded_file failed');
}
@chmod($target, 0640);
countSubmission($dir);

// ── Notification ────────────────────────────────────────────────────────────

// Fixed subject, fixed body, fixed sender. Nothing submitted reaches a header,
// and the report itself is not attached: it is on disk, and mailing arbitrary
// uploaded HTML to yourself is a way to get it opened by accident.
if (NOTIFY_EMAIL !== '' && function_exists('mail')) {
    @mail(
        NOTIFY_EMAIL,
        'OpenLiDARViewer: new external test report',
        "A new external test report was stored.\n\nFile: " . $name . "\nSize: " . $file['size'] . " bytes\n",
        "From: no-reply@" . preg_replace('/[^a-z0-9.\-]/i', '', (string) ($_SERVER['SERVER_NAME'] ?? 'localhost')) . "\r\n"
        . "Content-Type: text/plain; charset=utf-8\r\n"
    );
}

reply(200, true, 'Report received. Thank you.');
