"""Canonical token drift checks for the internal visual style.

The tokens draw from palettes: a role is an OKLCH expression of a palette's parameters, not a literal colour. The
contract still binds the default palette. Its signal colours, accent, and action stay literal in the tokens, and its
light surfaces, text, and borders are what the default palette's expressions come to, within a pixel. The contract's
dark surfaces are the ones the first version shipped: the default palette lifts them deliberately, so only the dark
accent and action are checked.
"""

import hashlib
import json
import math
import re
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
STYLE = ROOT / "skills/internal-visual-style"

# How far a derived light role may sit from the contract, per sRGB channel.
TOLERANCE = 4


def _block(css: str, opening: str) -> str:
    """The declarations of the first rule whose start is `opening`."""
    start = css.index("{", css.index(opening))
    depth = 0
    for at in range(start, len(css)):
        depth += css[at] == "{"
        depth -= css[at] == "}"
        if depth == 0:
            return css[start + 1 : at]
    raise ValueError(opening)


def _declarations(css: str) -> dict[str, str]:
    found = {}
    for opening in (":root,\n[data-palette] {\n  --palette-hue", ":root,\n[data-palette] {\n  --pyre-background"):
        for match in re.finditer(r"(--[\w-]+)\s*:\s*((?:[^;{}]|\n)*?);", _block(css, opening)):
            found[match.group(1)] = " ".join(match.group(2).split())
    return found


def _split_args(text: str) -> list[str]:
    out, depth, current = [], 0, ""
    for char in text:
        if char == "," and depth == 0:
            out.append(current.strip())
            current = ""
            continue
        depth += char == "("
        depth -= char == ")"
        current += char
    out.append(current.strip())
    return out


def _resolve(declarations: dict[str, str], value: str, mode: str) -> str:
    """The value with every var() substituted and every light-dark() taken on `mode`'s side."""
    value = re.sub(r"var\((--[\w-]+)\)", lambda m: _resolve(declarations, declarations[m.group(1)], mode), value)
    while "light-dark(" in value:
        at = value.index("light-dark(")
        start = at + len("light-dark(")
        depth, end = 1, start
        while depth:
            depth += value[end] == "("
            depth -= value[end] == ")"
            end += 1
        light, dark = _split_args(value[start : end - 1])
        value = value[:at] + (light if mode == "light" else dark) + value[end:]
    return value


def _oklch_to_hex(lightness: float, chroma: float, hue: float) -> str:
    a = chroma * math.cos(math.radians(hue))
    b = chroma * math.sin(math.radians(hue))
    l_ = lightness + 0.3963377774 * a + 0.2158037573 * b
    m_ = lightness - 0.1055613458 * a - 0.0638541728 * b
    s_ = lightness - 0.0894841775 * a - 1.2914855480 * b
    l, m, s = l_**3, m_**3, s_**3
    red = 4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s
    green = -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s
    blue = -0.0041960863 * l - 0.7034186147 * m + 1.7076147010 * s

    def encode(channel: float) -> int:
        channel = max(0.0, min(1.0, channel))
        channel = 12.92 * channel if channel <= 0.0031308 else 1.055 * channel ** (1 / 2.4) - 0.055
        return round(channel * 255)

    return "#%02x%02x%02x" % (encode(red), encode(green), encode(blue))


def _colour(value: str) -> str | None:
    """A hex colour as the browser would compute it; None for a color-mix(), which is not checked."""
    value = value.strip()
    if value.startswith("#"):
        return value.lower()
    match = re.fullmatch(r"oklch\((.*)\)", value)
    if match is None:
        return None
    parts, depth, current = [], 0, ""
    for char in match.group(1).replace("calc", ""):
        if char == " " and depth == 0 and current:
            parts.append(current)
            current = ""
            continue
        depth += char == "("
        depth -= char == ")"
        current += char
    parts.append(current)
    lightness, chroma, hue = (eval(part, {"__builtins__": {}}, {"min": min, "max": max}) for part in parts)  # noqa: S307
    return _oklch_to_hex(lightness, chroma, hue)


def _distance(a: str, b: str) -> int:
    return max(abs(int(a[at : at + 2], 16) - int(b[at : at + 2], 16)) for at in (1, 3, 5))


def _role_name(role: str) -> str:
    return re.sub(r"([A-Z])", lambda m: "-" + m[1].lower(), role)


class SharedStyleTests(unittest.TestCase):
    def setUp(self):
        self.raw = (STYLE / "references/reference-theme-contract.json").read_bytes()
        self.contract = json.loads(self.raw)["palette"]
        self.tokens = (STYLE / "assets/tokens.css").read_text()
        self.declarations = _declarations(self.tokens)

    def test_contract_is_the_recorded_one(self):
        self.assertEqual(
            hashlib.sha256(self.raw).hexdigest(),
            "15c1cde8fa5d169c755d492c851d5a8c36e5e9cc28110f8400b4cc0f543ae97c",
        )

    def test_signal_colours_accent_and_action_stay_exact(self):
        light, dark = self.contract["light"], self.contract["dark"]
        for role in ("error", "warning", "success"):
            self.assertIn(f"--pyre-{role}: light-dark({light[role]}, {dark[role]});", self.tokens)
        for role in ("accent", "action"):
            self.assertEqual(self.declarations[f"--palette-{role}"], f"light-dark({light[role]}, {dark[role]})")

    def test_default_palette_reproduces_the_contract_in_light(self):
        checked = 0
        for role, want in self.contract["light"].items():
            # The contract's "border" is the consumer alias --border, which points at the control border.
            declared = self.declarations.get(f"--pyre-{_role_name(role)}")
            got = None if declared is None else _colour(_resolve(self.declarations, declared, "light"))
            if got is None:
                continue
            checked += 1
            self.assertLessEqual(_distance(got, want), TOLERANCE, f"{role}: {got} is not within {TOLERANCE} of {want}")
        self.assertGreaterEqual(checked, 28)

    def test_every_palette_names_its_parameters(self):
        names = re.findall(r'\[data-palette="([a-z]+)"\]', self.tokens)
        self.assertEqual(len(names), len(set(names)))
        self.assertGreaterEqual(len(names), 9)
        for name in names:
            block = _block(self.tokens, f'[data-palette="{name}"]')
            self.assertIn("--palette-accent:", block, name)
            self.assertIn("--palette-action:", block, name)


if __name__ == "__main__":
    unittest.main()
