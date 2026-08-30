# LLM Anime source art

Action cards keep a lossless PNG master under `characters/<characterId>/actions/` and a compressed JPEG runtime copy under `public/themes/llm-anime/v1/characters/`.

Each character has exactly two cards:

- `call`: shared by chi, peng, and gang.
- `win`: shared by hu, self-draw, and robbing a kong.

Generated cards must not contain baked-in action words, nicknames, logos, or watermarks. Any visible mahjong tile must match a standard face from `public/tiles/`; pip count, honor glyph, orientation, perspective, hands, and character identity are checked before the character is added to the shipped manifest.
