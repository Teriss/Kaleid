# Wenku8 Flutter archive shelf adaptation

Repository: https://github.com/mikufoxxx/Wenku8_Flutter
Pinned revision: 689e8979002c69aaff60930fa45a9468998c51ab
Authors: mikufoxxx, MewX and the upstream contributors.

The upstream LICENSE retains the original GPL-2.0-or-later notice. NOTICE declares the Flutter distribution GNU GPL version 3. Its full GPL v3 text is retained in GPL-3.0.txt. These files and original Dart reference sources are preserved without modification.

Modified for Kaleid on 2026-10-22:

- Ported ArchiveShelfGeometry, the continuous extraction wave from archive_wave.dart, and ArchiveScrollSimulation to TypeScript in src/renderer/src/layouts/archiveShelfModel.ts. The adapted model is GPL-3.0-only and retains this provenance.
- Replaced Flutter render objects with CSS affine faces and SVG top polygons, with fixed left-to-right occlusion. Only visible loop slots are mounted; motion updates their transforms without rebuilding metadata every frame.
- Added desktop pointer, wheel and keyboard controls; local paged media, existing file actions, focus restoration and reduced-motion support.
- Added independently persisted finite/infinite shelf modes on 2026-10-22. Finite mode renders each real item once and bounds drag, wheel, keyboard and inertial movement at the first/last book. Removed the lower-left interaction hint.
- Used Kaleid's existing navigation, fonts and local media covers. No Wenku8 branding, novel files, covers, illustrations, Flutter packages, or bundled font assets are incorporated.

The application and adaptation are distributed as a GPLv3/AGPLv3 combination under section 13 of those licenses. GPL-covered portions retain GPLv3; the existing AGPLv3 portions retain AGPLv3. Do not remove upstream notices or relabel upstream code as solely AGPL. Editable adaptation and original reference sources are included in Kaleid-Source.zip, together with dependency lockfiles and build instructions.

