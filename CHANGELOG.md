# Changelog

What changed in each MRLatte release, newest first. Each release's notes are written here first;
the text of the GitHub release is copied from its section.
Releases: https://github.com/cogneuro-rgb/MRLatte/releases

## [0.5.0] — unreleased

Much faster and a third smaller, small workspaces that link to your scans (or hold everything) and
open with a double-click, a clearer module store, an Atlas Manager where each atlas installs and is
removed on its own (your own too), turn pivots, an optional white background and a dozen smaller
improvements.

### Faster
- **Startup: about 3.6 s instead of 19–24 s** to the brain on screen. Checking the tractography and
  network-mapping files (often linked from a network drive) used to read the whole connectome and
  hold up everything else for ~15 s. It now reads only what it needs, remembers the answer until the
  file changes, and never blocks the rest of the app. The quality-check warm-up also runs in the
  background now.
- **Drawing:** a stroke now finishes in about 16 ms instead of about 40 ms plus a quarter-second of
  follow-on work; undo takes 6–10 ms instead of 23 ms.
- **No more long freeze right after you start drawing.** The visual-field legend used to load four
  hidden full-size maps into the viewer as soon as a lesion existed (stalls of up to 27 s were seen).
  They are now kept off the graphics card; a map is shown only when you turn it on.
- **Layer changes no longer freeze:** dragging an opacity, colour or position control used to stall
  for up to 5–6 seconds at a time. Each change now takes a steady ~47 ms.

### Smaller
- **Installer 133 MB (was 258 MB); installed size about 407 MB (was 917 MB).** The app no longer
  carries copies of packages that were already built into its interface (227 MB), ships only the
  English language pack, leaves out the parts below and the atlases that only some people need
  (each a one-click install), and drops a duplicate copy of the DICOM converter and files only
  needed to compile code.
- **Optional features install and remove with one click** from the module store. A module counts as
  in use only while a job that needs it is running: opening its panel doesn't count, and once the
  result is back (say, the difference map is in the viewer) it can be removed at once. While a job
  runs, the store asks you to remove it once that finishes. Longitudinal comparison and atlas
  validation now run in their own process, like dissection and network mapping already did.
- **Longitudinal comparison is now a one-click module** in the standard installer. Until SimpleITK
  is installed, the panel opens the module store at it (a 19 MB download from PyPI, checked against
  a pinned hash); after that it works as before, also after restarting. The full installer still
  includes it.
- **Tract dissection's engine (dipy) is a one-click module** (a 15 MB download, 35 MB installed).
  Dissection also needs the whole-brain tractogram, so only people who add one need it; the
  Tract Dissection section lists both, each with its install button.
- **The network-map figures and the retinotopy validation toolkit are one-click modules too** (they
  used to say "not installable from the app"). Network-map figures (nilearn, matplotlib, pandas) is a
  51 MB download; the validation toolkit (neuropythy) 41 MB. Every file comes from PyPI and is
  checked against a pinned hash. The full installer still includes all of these. LQTpy Analysis and
  the reports need none of them.

### Atlases
- **The Atlas Manager is one window for everything to do with atlases:** the template, every atlas,
  the tract and retinotopy atlases, the catalog of further atlases and your own. Open it from the
  Atlases section or the module store, which now lists all of these as one row.
- **Each atlas installs and is removed on its own**, the MNI152 template too; removing one says what
  stops working without it. The template and the seven core atlases still come with the installer
  and reinstall from MRLatte's own copy, without a download. The tract atlases (HCP1065, HCP842,
  IIT, JHU), the retinotopy maps (Benson 2014, Wang 2015) and the atlas-validation surfaces download
  when you install them, from the project's GitHub release, each file checked against a pinned hash.
- **Add your own atlas** with the button, or drop a `.nii`/`.nii.gz` (and its label file) onto the
  window. Besides label volumes, 4-D probability atlases (one map per region, like the tract
  atlases) now import: MRLatte builds the label map at a cut-off you choose and keeps the per-region
  maps, so reports break a lesion down by them as they do for HCP1065.
- **Removing the template takes effect at once:** the viewer goes empty with your overlays kept, and
  a notice (which you can minimise) says how to get a base back. Reinstalling the template loads it.
- **Removing an atlas also removes the left/right copies split from it;** the confirmation names
  them.
- **Every removal can be undone for 5 seconds** from its notification. Messages like "Uninstall
  complete" now clear themselves after a few seconds; errors stay until you dismiss them.
- The catalog of further atlases no longer offers second copies of the atlases MRLatte ships.
- Confirm and Cancel sit on the right, under the button you pressed. The module store and the Atlas
  Manager open with a short animation, and opening one from a section's install prompt brings you
  to that module and highlights it.
- **Fixed:** the Atlases section was greyed out even with atlases installed; an atlas removed in the
  installed app came back the next time MRLatte started; and the catalog of further atlases was
  empty there.

### Workspaces
- **Saved as `.mrlatte` and opened by double-click** in Explorer. Workspaces saved by earlier versions
  (`.nvws.json`) still open from the Open button.
- **A workspace now holds everything:** a custom base volume, the unsaved drawing, layer notes, the
  mosaic settings and saved MNI coordinates, alongside the layers, view and crosshair it already
  kept.
- **Small by default:** Save asks how. **Link to the files** (the highlighted choice) saves where each
  scan is on disk plus every setting and adjustment, so the file is a few kilobytes and opens wherever
  those files are (this computer or a shared drive). **Embed everything** puts a copy of every scan
  inside, so it opens on any computer. The unsaved drawing, and any layer made in the app, is always
  embedded.
- **A DICOM base is converted again** when a linked workspace opens, from its original folder or zip,
  with a message saying why it takes a moment.
- **If a linked file has moved**, the rest of the workspace still opens and MRLatte lists the files it
  couldn't find. Files on another computer (a network share) are read only after you say yes.
- **Fixed: opening a workspace always showed the MNI template** instead of the base it was made on.
  It now loads its own base, or switches back to the template if that is what it was made on. A
  workspace saved by an earlier version with a custom base can't bring that base back, and says so.
- A workspace with a custom base or linked files can't be opened by MRLatte 0.4.x.

### New
- **Turn about:** the position block's turns (and resizes) can pivot on the centre of the visible
  voxels (the default), their centre of mass, or the crosshair. Changing the pivot never moves the
  layer. An **update** button turns yellow when the pivot is out of date (the visibility window
  changed, or the crosshair moved in crosshair mode). Layers adjusted in earlier versions keep their
  position.
- **Optional white viewer background** for figures and screenshots: the square button next to
  Radiological. The viewer stays black by default, which is better for reading scans.
- **Invert colormap on the base volume**, in the slices and the 3D render.
- **Lock the colour range to the visibility values:** a lock beside a layer's colour range makes the
  colours span exactly the values that are shown, and follow them as you change the visibility.
- **Direction letters on the move bars** (L–R, P–A, I–S) and a **reset button for each bar**.
- **MNI coordinates menu:** the coordinate box (and any saved coordinate) turns green when the
  crosshair is on it, and clicking in the viewer no longer closes the menu.
- **Loading screen** shows what is happening: starting the analysis engine (with seconds), loading
  the interface, the brain template, the module check. The logo stays put; the steps list below it.
- **Sections whose module isn't installed are greyed out** (they still open, to offer the install).
- **The version number links to its release page** on GitHub.

### Changed
- **Reports are redesigned, with real figures.**
  - Both the lesion report and the LQTpy Analysis report open with a few short sentences — size,
    side and centre, the main regions, and the visual field, tracts and network when those ran —
    then a figure of the lesion on the scan: three views through its centre and axial slices across
    it, labelled left/right. It is drawn from the volumes themselves, so it needs no extra module
    and still shows when a saved report is opened later. The PDF export includes it too, with the
    same short lead and each atlas's top five regions.
  - The LQTpy Analysis report adds still figures of the affected tracts and of the positive and
    negative network. The report is the run's one figure output: the interactive viewer pages it
    used to make (which showed blank in a saved report) are gone, and Download offers the run's data
    — the maps and the overlap table.
  - More concise: tables show their top five rows (with a bar for each region's share), the rest
    folded under "N more"; the long-form detailed measures are folded at the end; each analysis
    has its own heading instead of three "Key Statistics"; visual-field maps appear only when a
    retinotopy map found something; "not available" notes are one line; and how the report was made
    (engine, atlases, inputs) is a short Method list at the end. Prints cleanly on A4.
- **The module store is redesigned:** one line per module (status, name, size and the one action that
  matters), grouped as Needs attention, Installed and Available. Licence, file choices, Verify and
  Remove sit under each module; file lists and hashes under Technical details.
- **Saved MNI coordinates last for the session** (and travel in workspaces) instead of reappearing in
  every later session.
- **The base volume no longer has move and turn controls.** Overlays and the drawing keep theirs.
- **The colour bar in the viewer spans the visibility window** (the values actually shown), coloured
  as those values are drawn, instead of the colour range.
- **Switching to Asymmetric from Axial, Coronal or Sagittal** keeps that view as the large one.
- **Quality check uses [LQTpy 0.7.0](https://github.com/rohan3412/LQTpy/releases/tag/v0.7.0).** It
  also flags comb-like and blocky drawings and slices drawn only partly (each with Go to), and
  several smaller findings together now make a mask "fix before use". It is faster; everything else
  it reports is unchanged. The quality check and the LQTpy analysis setup name the lqtpy version
  they run on, with a link to its release.
- **Undo notifications show how long they stay:** a bar along the bottom drains until the Undo is
  gone, and holds while the pointer is over it.
- **Asymmetric from Multiplanar + 3D** makes the highlighted view (the one last clicked or scrolled
  in) the large one.

### Fixed
- **The visual-field maps in reports** showed whatever the Retinotopy panel happened to show —
  often an empty disc, once even "select a lesion". They are now drawn for the report's own lesion
  (and in the LQTpy Analysis report too), so they agree with the findings table beside them.
- **Deleting a lesion left it in the 3D render** (also after loading a new base). It now goes from
  every view.
- **Auto colour range and auto visibility gave the wrong values** for scans stored as whole numbers
  with a scale factor (the MNI152 template is one): the window came out in the stored numbers, not
  the values shown.
- A retinotopy layer that had been loaded for the legend turned on at 0 % opacity.
- Updates now refresh the module list, so new or changed modules reach existing installs.

### Install
Download `MRLatte-Setup-0.5.0-mini-x64.exe` and run it. It installs over any earlier version.

## [0.4.1] — 2026-10-22

One-click fixes for stray marks, interpolation for erasing, moving the drawing itself, a new
hold-to-move control, an optional white viewer background, and LQTpy 0.6.1.

### New
- **Fix button in the quality check.** Findings MRLatte can safely clean up (stray specks and
  strokes, marks along the edge of the scan, parts outside the brain) now have a **Fix** button next
  to **Go to**. It removes just those voxels and nothing else. The message says how many were
  removed, and its **Undo** puts them back (so does the usual Undo). Findings that would need voxels
  *added* (gaps, holes, outlines) still have only Go to.
- **Interpolate erasing.** Erase the same shape on two slices of one view (right-drag with the Pen,
  or the 2D Brush) and press **Interpolate**: the shape is carved out of every slice in between.
  **Interpolate all** now fills between drawn slices and carves between erased slices in one go.
- **Move, turn and resize the drawing.** The Draw panel has the same **position** block as layers:
  move (mm), turn (degrees) and size (%). It moves the drawn voxels themselves, keeps each pen
  colour, and each adjustment is one Undo. The numbers show the adjustment since your last other
  edit and go back to zero when you draw, erase or undo.
- **Hold-to-move bars instead of sliders** in every position block (layers, base, drawing). The
  middle is still. Press and hold either side to move, and release to stop. Speed rises steeply
  towards the ends: slow and fine over most of the bar, and up to 100 mm/s, 180°/s and 200 %/s at
  the very end. Hovering shows the speed it would move at. The arrow keys still step, and the number
  boxes are unchanged.
- **Turning has no limit.** Holding a turn bar keeps turning round and round. Angles are shown
  between −180° and 180°, so 190° reads as −170°, which is the same turn.
- **Sagittal flip.** A small ⇄ button on the Sagittal view button makes the nose point left or right
  in every sagittal view, mosaic included. It is a turn of the view, not a mirror, so the A/P letters
  swap with it. It is remembered with your other view settings.
- **Optional white viewer background**, for figures and screenshots: the square button next to
  Radiological. The viewer and the empty space round the head in the 2D slices turn white, while
  dark tissue (ventricles, CSF) stays black. It works in either theme and is saved with the
  workspace. The viewer stays black by default, which is better for reading scans.

### Changed
- **Quality check uses LQTpy 0.6.1.** It now catches a slice forgotten in the middle of a large
  lesion, and grades far-off stray specks at least "Check".
- **The version number** now sits next to the MRLatte name at the top of the sidebar.

### Fixed
- **Dropping a NIfTI file on the viewer** swapped what was shown but left the dashboard showing the
  previous file's name and layers. A dropped file is now opened the same way as a double-click in
  Explorer: a scan becomes the base; a lesion or activation map is added as an overlay, with a "Use
  as base instead" option.
- **"Open with" showed "Electron"** instead of MRLatte on PCs that ever had version 0.3.x installed.

## [0.4.0] — 2026-10-09

The first release since 0.3.0. It has a quality check for drawn lesions, manual repositioning of
overlays, a placeholder app icon, and a fix for updates that seemed not to take.

### New
- **App icon (placeholder).** MRLatte no longer shows Electron's default icon. The icon in this
  release is a stand-in, to be replaced by a final design in a later release.
- **Quality check for drawn lesions.** When you Save or Download a drawing, MRLatte checks it with
  LQTpy 0.6.0 and tells you if something looks wrong: drawn on some slices only, left as an outline,
  drawn on a single slice, stray marks, parts outside the brain.
  - Each finding is graded (minor, moderate, major) and the drawing gets an overall verdict.
  - **Go to** jumps the viewer to where the problem is; **Interpolate all** is offered when slices
    were skipped.
  - Small notes never interrupt you, and you're never asked twice about the same drawing.
  - While you draw, an orange box appears on the viewer if the drawing looks wrong after 30 seconds
    without drawing.
  - The check can never stop you saving: if it can't run, saving goes ahead as normal.
- **Move, rotate and resize by hand.** Every lesion mask, activation map and the base volume has a
  **position** block in its layer card: move (mm), turn (degrees) and size (%), plus reset.
  Analyses, downloads and saved workspaces use the adjusted position; the file's voxels are never
  changed. A workspace containing an adjusted layer can't be opened by MRLatte 0.3.x.
- **View NIfTI headers** from a button on every layer card, with "Show all fields" for every raw
  header field.
- **Right-click menu in Explorer:** **MRLatte › Open** and **MRLatte › View NIfTI header** on `.nii`
  and `.nii.gz` files (an install option, on by default).
- **`mrlatte://` links can open a base scan plus overlays**, e.g.
  `mrlatte://open?base=C:\scans\t1.nii.gz&overlay=C:\scans\lesion.nii.gz`. Up to 8 local files;
  overlay types are detected automatically or forced with `&overlaytype=`.
- **Smaller window with the sidebar closed** (down to 480 px wide).
- **Version shown** in the status bar.

### Fixed
- **After updating, MRLatte could keep showing the previous version's screen** for hours or days.
  It now always checks for the current interface and clears its cache the first time a new version
  starts.
- **Opening a scan as the base from Explorer or a `mrlatte://` link** failed with "Cannot read
  properties of undefined (reading 'toUpperCase')".
- **Interpolate All now works with the Brush** (2D and 3D), not only the Pen.
- **"Current drawing (unsaved)"** is no longer offered when nothing is drawn.

### Changed
- **Interpolate All orientation menu** follows the view you last drew in, outlines the selected view
  and greys out views without two drawn slices.
- **One-Click Summary is now "LQTpy Analysis".**

## Earlier releases

- **0.3.0** — see https://github.com/cogneuro-rgb/MRLatte/releases/tag/v0.3.0
- Releases before 0.3.0 had no published notes.
