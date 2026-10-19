---
layout: home

hero:
  name: OpenLiDARViewer
  text: Open LiDAR and 3D scans in a browser tab
  tagline: Drone LiDAR, terrestrial laser scans and phone scans open in a browser tab. No install and no account; local files are not uploaded.
  actions:
    - theme: brand
      text: Open the viewer
      link: https://app.openlidarviewer.org/
    - theme: alt
      text: Quickstart
      link: /guide/
    - theme: alt
      text: Scientific validation
      link: /validation/

features:
  - title: Local files stay local
    details: Files are read and rendered in your browser. There is no server to upload to. Remote datasets are requested only from a URL you open.
  - title: Twelve import formats, four streaming
    details: "LAS, LAZ, E57, PLY, OBJ, GLB, GLTF, XYZ, PCD, PTX, PTS and a single 3D Tiles PNTS tile for static loads. CSV, ASC and TXT are read as XYZ. Four streaming paths with bounded memory: progressive COPC and EPT, 3D Tiles PNTS tilesets, and out-of-core LAS / chunked LAZ indexed via OPFS."
    link: /formats/
    linkText: Format matrix
  - title: Evidence levels
    details: Every scientific product carries an evidence level, and the claim register records what each result may and may not be called.
    link: /validation/claim-register
    linkText: Claim register
  - title: Terrain intelligence
    details: A confidence-aware DTM and contour pipeline with hold-out validation, evidence-graded exports, and an export gate tied to the evidence level.
    link: /guide/terrain-intelligence
    linkText: How it works
---
