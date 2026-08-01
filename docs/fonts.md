# Fonts

Two fonts ship with the app, in `public/fonts/`:

| File | Size | What it's for |
|---|---|---|
| `Nunito-latin.woff2` | 39KB | All text. Variable font — one file covers weights 400–700. |
| `NotoColorEmoji-COLRv1.woff2` | 1.9MB | Emoji only, scoped by `unicode-range`. |

Both are declared in `public/style.css` and preloaded from `public/index.html`.

## Why bundle them at all

**Determinism, not a browser bug.** Left to system fonts, both the text face and
the emoji face resolved differently on every device, and this is an app where a
child picks an emoji from a palette and sends it to a bot that sends emoji back
— the palette and the message should look the same, on every screen in the
house.

For text, the old stack (`"Trebuchet MS", "Segoe UI", Verdana, system-ui,
sans-serif`) produced Trebuchet MS on Windows/macOS, San Francisco on iOS,
Roboto on Android, and on a Linux box with none of those installed it fell all
the way through to Droid Sans. Nunito is rounded and highly legible, which
suits a 6-year-old.

For emoji the situation was worse — see below.

## The emoji story, and what is *not* true

It is tempting to write this off as "Chromium can't render CBDT/CBLC". **That
is false.** CBDT/CBLC is Google's own bitmap format and it is what Android
ships; Chromium/Skia supports it.

What is actually true is narrower, and was established by testing rather than
assumption:

- Left to the system, emoji resolve to whatever font fontconfig ranks first for
  a given codepoint, and that answer differs per machine. On the Artix box this
  was developed on, `fc-match :charset=1f642` ranks *Adwaita Mono* ahead of Noto
  Color Emoji — so 🙂 came out monochrome, and anything no UI font covered came
  out as tofu. That is the "only a heart and a face render" symptom.
- Asking for the packaged CBDT `Noto Color Emoji` **by name** paints *nothing*
  at all in Brave — blank, not tofu, which means the font was selected and the
  rasteriser produced an empty result.
- Firefox rasterises that same file correctly via FreeType, which is why Firefox
  always looked fine.
- On Windows the failure mode is different again: Segoe UI would answer ✏ ⭐ ❤
  first, with monochrome glyphs.

### A fontconfig fix does not help

The usual advice — install `70-no-bitmaps-except-emoji.conf` and a
`*-noto-color-emoji.conf` — was tested directly, by running Brave with a
`FONTCONFIG_FILE` that appended `Noto Color Emoji` to `sans-serif`/`serif`/
`monospace` **and** forced `embeddedbitmap`/`scalable` on that face.

Against a stock-config control the two renders were **byte-identical** (same
SHA-256, zero differing pixels). Selection was never the problem — fontconfig
already offered the font — so no amount of configuration reaches the failure.

Conclusion: a system-level fix would not have helped even on the one machine it
could apply to, and the app serves every device on the LAN anyway. Bundling is
the only thing that makes emoji look the same everywhere.

## Why `unicode-range` is load-bearing

The emoji face is listed **second** in `--font`, ahead of every system font, so
none of them can answer an emoji codepoint first with a monochrome glyph. That
placement is only safe because the face is scoped:

```css
unicode-range: U+200D, U+2600-27BF, U+2B00-2BFF, U+FE0F,
               U+1F000-1FAFF, U+E0020-E007F;
```

`U+FE0F` (emoji presentation selector), `U+200D` (ZWJ) and the tag block are
included so multi-codepoint sequences resolve to a single face.

**The scope matters in both directions.** Noto Color Emoji has cmap entries for
`0-9`, `#` and `*` — the keycap bases. An *unscoped* face placed first renders
digits in the emoji font. This was reproduced before the range was added.

Verified against this app's actual glyphs:

- All **117** palette emoji fall inside the ranges — none are orphaned.
- The UI symbols that sit inside the ranges by codepoint — `✕` U+2715, `☰`
  U+2630, `➤` U+27A4 — are **absent from the font's cmap**, so they fall
  through to the text face as intended.
- `→` U+2192 and `↓` U+2193 are outside the ranges entirely.
- Nunito has **zero** overlap with the ranges (230 codepoints, max U+2215), so
  it can never win an emoji codepoint.

Measured after the change: digits, `#*`, letters, `➤`, `✕`, `☰` all resolve to
the text face; 🙂 and ⭐ resolve to the emoji face.

If you add emoji to the palette in `public/app.js`, check they fall inside these
ranges.

## `font-display`: `swap` for text, `block` for emoji

They differ deliberately.

- **Nunito uses `swap`.** The fallbacks all have these glyphs, so the worst case
  is a brief change of typeface — never a blank or a tofu box. `system-ui` runs
  about 6% wider than Nunito, so the swap nudges the layout slightly; that is
  acceptable given the font is preloaded and only 39KB.
- **The emoji face uses `block`.** With `swap` the browser paints the fallback
  first, and since no local font reliably has these glyphs that fallback is a
  tofu box — which then survived on whichever elements happened not to repaint
  after the font arrived, unpredictably. `block` renders nothing for those
  characters until the font is ready, so a tofu box is never painted. Paired
  with the preload the wait is imperceptible on a LAN.

## Fallback order

```css
--font: "Nunito", "Noto Color Emoji COLR", system-ui, -apple-system,
        "Segoe UI", Roboto, sans-serif;
```

Everything after the two bundled faces only matters for the moment before they
arrive, or if they fail to load entirely. `system-ui` leads that fallback so the
app borrows whatever face the machine is set to.

An earlier version pinned `"DejaVu Sans", "Liberation Sans"` ahead of
`system-ui` purely to dodge Droid Sans. That had the side effect of overriding
the user's own system font, so those pins were removed. Note that on the machine
this was found on, DejaVu was not even installed — the entry was inert there,
but Liberation Sans was, and it did win over the system font.

## Caching

`server.js` mounts `/fonts` with `max-age=31536000, immutable`. Without it
`express.static` sends `max-age=0`, so the browser revalidates ~2MB of font on
every page load — and that round trip lands before first paint, which with
`font-display: block` means emoji stay blank until it completes.

App code (`style.css`, `app.js`, the HTML) is deliberately left at `max-age=0`
so deploys take effect immediately.

**The filenames are the version tags.** If you swap in a different font, rename
the file, or cached clients will keep the old one for up to a year.

## Regenerating or replacing the emoji font

The bundled build is COLRv1 (`COLR` + `CPAL` + `glyf`, 1024 upem, no bitmap
tables), which works in Chromium 98+ and Firefox 110+. The COLRv1 build is
~1.9MB as woff2 against roughly 10MB for the CBDT original.

To inspect what you have:

```sh
woff2_decompress public/fonts/NotoColorEmoji-COLRv1.woff2
# then dump the table directory — COLR/CPAL present, CBDT/CBLC absent
```

Subsetting to just the palette would cut the size considerably, but Sparky's
replies can contain **any** emoji, so a subset would leave model-emitted emoji
falling back to the system — reintroducing exactly the inconsistency the bundle
exists to prevent.
