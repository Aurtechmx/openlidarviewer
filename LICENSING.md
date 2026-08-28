# Licensing

This document explains how OpenLiDARViewer is licensed, what changed at v0.6.7,
and how third-party components and datasets fit in. It is a guide, not a
contract. The controlling texts are the [LICENSE](LICENSE) file and the
individual notices referenced below.

## Current license

OpenLiDARViewer v0.6.7 and later is distributed under the GNU Affero General
Public License version 3 only (`AGPL-3.0-only`). The full text is in
[LICENSE](LICENSE). AGPL adds one obligation beyond GPL: if you run a modified
version and let other people interact with it over a network, you must offer
those users the corresponding source of your modified version.

Copyright (C) 2026 Aur Technologies and OpenLiDARViewer contributors.

## Licensing history

Releases through v0.6.6 were distributed under the MIT License. Beginning with
v0.6.7 the project is distributed under AGPL-3.0-only. This change is
forward-looking. It does not alter any earlier release: a copy obtained under
MIT stays under MIT, and the historical tags and archives are not rewritten.

| Release        | License        |
| -------------- | -------------- |
| v0.6.6 and earlier | MIT        |
| v0.6.7 and later   | AGPL-3.0-only |

## Third-party components

OpenLiDARViewer bundles and links against third-party open-source packages,
fonts, and a WASM codec. These keep their own licenses, and their notices
remain applicable. Every runtime component is compatible with AGPL-3.0-only:
the rendering, parsing, projection, and PDF libraries are MIT, the LAZ codec is
Apache-2.0, and the fonts are under the SIL Open Font License. The full list,
with versions and upstream links, is in
[docs/project/THIRD_PARTY_NOTICES.md](docs/project/THIRD_PARTY_NOTICES.md).

The project license does not override a component license. A permissively
licensed dependency inside an AGPL distribution still carries its own terms.

## Datasets and scientific assets

The datasets, validation fixtures, curated sample URLs, and reference material
in this repository are licensed by their own publishers, not by OpenLiDARViewer.
AGPL applies to the software. It does not change the license of any dataset. The
per-dataset publisher, license, and provenance are recorded in the dataset
registry and the [Credits](public/credits.html) page.

## Commercial licensing

The AGPL community edition is the full application, free to use, study, modify,
and share under AGPL-3.0-only. Organizations that need terms AGPL does not
grant, such as closed-source embedding, OEM redistribution, proprietary
modifications, or enterprise distribution, may obtain a separate commercial
license where Aur Technologies holds the necessary rights. See
[COMMERCIAL-LICENSING.md](COMMERCIAL-LICENSING.md).

## Contributions

Contributions are accepted under a Contributor License Agreement so the project
can keep both the open AGPL edition and a commercial edition consistent. See
[CONTRIBUTING.md](CONTRIBUTING.md) and [docs/CLA.md](docs/CLA.md).
