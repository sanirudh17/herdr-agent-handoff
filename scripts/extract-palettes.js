// Parses Herdr's src/app/state.rs and emits the palette table as JS.
const fs = require("node:fs");

const SRC =
  "C:/Users/sanir/AppData/Local/Temp/claude/C--Users-sanir-Herdr-plugin/ae39a48c-52dd-48e6-a3cf-262b2ccb0f5f/scratchpad/herdr-repo/src/app/state.rs";
const text = fs.readFileSync(SRC, "utf8");

const WANT = [
  "accent",
  "panel_bg",
  "surface0",
  "surface_dim",
  "overlay0",
  "overlay1",
  "text",
  "subtext0",
];

// Split on palette constructors.
const parts = text.split(/pub fn ([a-z_0-9]+)\(\) -> Self \{/);
const palettes = {};
for (let i = 1; i < parts.length; i += 2) {
  const name = parts[i];
  const body = parts[i + 1].split(/\n {4}\}/)[0];
  if (name === "test_new" || name === "from_name" || name === "with_overrides")
    continue;
  const colors = {};
  for (const field of WANT) {
    const rgb = body.match(
      new RegExp(`${field}:\\s*Color::Rgb\\((\\d+),\\s*(\\d+),\\s*(\\d+)\\)`),
    );
    if (rgb) {
      colors[field] = [Number(rgb[1]), Number(rgb[2]), Number(rgb[3])];
      continue;
    }
    const named = body.match(new RegExp(`${field}:\\s*Color::([A-Za-z]+)`));
    if (named) colors[field] = named[1];
  }
  if (colors.accent) palettes[name] = colors;
}

// The from_name() alias table.
const fromName = text.split("pub fn from_name")[1].split("_ => None")[0];
const aliases = {};
for (const line of fromName.split("\n")) {
  const m = line.match(
    /^\s*((?:"[a-z-]+"\s*\|?\s*)+)=>\s*Some\(Self::([a-z_0-9]+)\(\)\)/,
  );
  if (!m) continue;
  const fn = m[2];
  for (const name of m[1]
    .match(/"([a-z-]+)"/g)
    .map((s) => s.replace(/"/g, ""))) {
    aliases[name] = fn;
  }
}

const f = (v) =>
  Array.isArray(v) ? "[" + v.join(", ") + "]" : JSON.stringify(v);
console.log(
  "// palettes: " +
    Object.keys(palettes).length +
    ", aliases: " +
    Object.keys(aliases).length,
);
console.log("const PALETTES = {");
for (const [name, c] of Object.entries(palettes)) {
  const body = WANT.map((k) => `${k}: ${f(c[k])}`).join(", ");
  console.log(`  ${name}: { ${body} },`);
}
console.log("};\n");
console.log("const THEME_ALIASES = {");
for (const [name, fn] of Object.entries(aliases))
  console.log(`  "${name}": "${fn}",`);
console.log("};");
