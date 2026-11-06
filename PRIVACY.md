# Viewer privacy

## Files and network requests

OpenLiDARViewer processes files you open from your device in your browser.
Opening a local scan, measuring it and creating an export do not upload the
scan or measurements. The viewer has no usage analytics or telemetry service.

The viewer downloads its application files from the site serving it. When you
open a remote dataset or sample, it requests the file or the tiles needed for
the view directly from the dataset host. Each host receives the connection's
IP address and the requested URLs. Hosting providers set their own access-log
and retention policies.

When you run a location search in the public LiDAR catalogue, the viewer sends
a geographic bounding box centred on the coordinates you entered to Microsoft
Planetary Computer. Opening a result sends the tile URL to Microsoft's signing
service and then requests the tile from its host. Add `?notelemetry=1` to the
viewer URL to disable the public catalogue and local usage counters. You can
still choose to open a remote dataset or sample.

## What the browser keeps

- **Session recovery.** While recovery is enabled, the viewer saves session
  information, including scan names, measurements, annotations and views, in
  IndexedDB or, when available as a fallback, local storage. When recovery next
  starts, it removes entries last saved more than seven days earlier. Entries
  can remain on disk while the viewer is closed. Choose **Clear recovery data**
  in Help to erase the recovery entries.
- **Scan and terrain caches.** For large local scans the viewer can store
  indexed point tiles on disk in the browser's origin-private file system. It
  can also keep computed terrain there for reuse across sessions. Clearing
  recovery data leaves these caches in place.
- **Preferences and counts.** The viewer keeps settings such as theme and
  navigation preferences. Session Stats shows local usage counts.
- **Application files.** A service worker caches viewer files. Choosing
  **Make available offline** saves a more complete copy for offline use.
  **Remove offline copy** removes the saved offline copy.
- **Report signing.** If you choose to create a signing key, the browser stores
  a non-exportable private key in IndexedDB. Signed reports include the public
  key and its identifier. Someone who receives two signed reports can tell
  whether the same key signed them.

To remove the viewer's browser-stored data, including point tiles, terrain and
the signing key, clear site data for this viewer's origin in your browser.
Files you explicitly downloaded or shared are separate copies. The Session log
lives in tab memory and a reload clears it. You can copy or export it yourself.

## Warranty

See sections 15 and 16 of the [GNU AGPL](LICENSE) for the warranty terms.
