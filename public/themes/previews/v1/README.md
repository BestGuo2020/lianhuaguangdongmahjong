# Theme preview assets v1

These five 320×180 SVG previews were authored in-repository for the table presentation system. They use only geometric shapes, gradients, and theme palette colors; no external artwork, logos, regional symbols, or third-party assets are included.

- Runtime path: `themes/previews/v1/<theme>.svg`
- Source: the SVG files in this directory
- License: project-owned source asset
- Generation: hand-authored SVG
- Responsive crop: preserve `16:9`; consumers should use `object-fit: cover`
- Loading: small lobby previews may load on demand; full action and settlement art must not be preloaded here
- Failure fallback: render the theme's CSS gradient and text label
