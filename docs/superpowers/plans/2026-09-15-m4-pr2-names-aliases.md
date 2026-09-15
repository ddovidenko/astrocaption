# Milestone 4 PR 2: Names and Aliases Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Both renderers rank catalogue names and build the alias line from the same rules, pinned by a new names-vectors contract, with a `max_aliases` style field and a config dropdown that no longer duplicates its default.

**Architecture:** The Python classifier and ranking in `backend/app/models.py` gain an `alias_names` policy (drop star ids and unknown abbreviations when better aliases exist, drop nested common names, common names first, cap). `frontend/src/editor/names.ts` is a line-by-line port; `metrics.ts`'s `labelText` builds both lines from `catalog_names` and the store's style instead of the server's `primary_name`. A generator writes `tests/fixtures/names/vectors.json` from Python and both test suites replay it, the same way placement and render vectors work today. The render vectors are regenerated because every alias line changes.

**Tech Stack:** Python 3.13+ / pydantic / pytest; TypeScript strict / vitest; Pillow via the existing render-vectors generator; Playwright for the parity pixel diff.

**Spec:** `docs/superpowers/specs/2026-09-14-milestone-4-styling-design.md`, section B ("Name ranking in TypeScript", "Alias policy", "Name preference on the config page") and "Data model and API changes". Issues #13, #64, #73.

## Global Constraints

- Preview and export must produce the same layout (CLAUDE.md hard rule). Both renderers change in the same commit (Task 2), `make render-vectors` is re-run there, and `backend/tests/test_render_parity.py`, `frontend/src/editor/metrics.test.ts` and `frontend/e2e/parity.spec.ts` must pass at the end of that task.
- Alias policy, verbatim from the spec: (1) drop the primary; (2) drop `star` and `designation` names when at least one alias of any other category exists; (3) drop a `common` name whose text is contained in another `common` name of the same object, case-insensitive; (4) `common` names first in nova's order, then every other category in the primary-name ranking order for the current preference, ties in nova's order; (5) keep the first `style.max_aliases`. `max_aliases: int` bounds 0–5, default 2. `show_aliases=False` or `max_aliases=0` both mean no alias line.
- Worked examples that must hold: M 42 (`["NGC 1976","M 42","LBN 974","Great Orion Nebula","Orion Nebula"]`) under `popular` → primary `M 42`, aliases `["Great Orion Nebula","NGC 1976"]` at cap 2 and `["Great Orion Nebula","NGC 1976","LBN 974"]` at cap 5; under `ngc_ic` → primary `NGC 1976`, aliases `["Great Orion Nebula","M 42"]`. M 45 (`["Mel 22","M 45","Pleiades"]`) → `M 45` over `["Pleiades","Mel 22"]`.
- The TypeScript port must reproduce the Python output exactly for every case in `tests/fixtures/names/vectors.json`; the pytest replay fails while the file is stale, like the render vectors.
- Coordinates and geometry are untouched; the label text is the only rendering input that changes.
- No new dependencies. TypeScript strict, ruff defaults, mypy strict. Pydantic models for every request/response; `extra="forbid"` stays on `StyleConfig`, `Label`, `StyleOverrides`.
- API responses and the page never carry raw exception text.
- Conventional one-line commit subjects; end every commit message with the attribution trailer the session reminder gives.
- Never run `npm ci`/`npm install`/`make install FORCE=1`; never touch `data/`; never restart the `astrocaption-dev` unit. `make lint test` and `make e2e` are the acceptance gates (both use scratch dirs).

---

## File structure

| File | Responsibility after this PR |
|---|---|
| `backend/app/models.py` | `NamePreference`, classifier, ranking, `primary_name`, new `alias_names`, `MAX_ALIASES`, `StyleConfig.max_aliases`, `StyleOverrides.max_aliases`, `StyleDefaults.max_aliases`, `SolveObject.aliases_for(preference, max_aliases)` |
| `backend/app/render.py` | `label_text` passes `style.max_aliases` |
| `backend/scripts/make_names_vectors.py` | New: writes `tests/fixtures/names/vectors.json` |
| `backend/scripts/make_render_vectors.py` | Glyph strings and label cases follow the new alias lines; a case with `max_aliases=5` |
| `backend/tests/test_objects.py`, `test_names_vectors.py` (new), `test_config_api.py` | Policy unit tests, vectors replay, config round trip |
| `frontend/src/editor/names.ts` (new) + `names.test.ts` (new) | The port and its replay |
| `frontend/src/editor/metrics.ts` | `labelText` uses `names.ts` and `style.max_aliases` |
| `frontend/src/api.ts` | `StyleConfig.max_aliases`, `StyleDefaults.max_aliases` |
| `frontend/src/editor/testDoc.ts`, `frontend/src/pages/labelPreview.test.ts`, `configForm.test.ts` | Style literals gain the field |
| `frontend/src/pages/configForm.ts`, `ConfigPage.tsx`, `labelPreview.ts`, `LabelPreview.tsx` | `max_aliases` field, dropdown without the duplicate entry, preview lines with the new policy |
| `Makefile`, `CLAUDE.md`, `docs/SPEC.md` | `make names-vectors`; § 6.2 alias rule, § 6.3 Style fields, § 7, § 9 |

---

### Task 1: TypeScript port of the classifier and ranking

**Files:**
- Create: `frontend/src/editor/names.ts`
- Create: `frontend/src/editor/names.test.ts`

**Interfaces:**
- Produces: `export type Category = 'messier' | 'caldwell' | 'sharpless' | 'barnard' | 'ngc' | 'ic' | 'catalogue' | 'designation' | 'common' | 'bayer' | 'flamsteed' | 'star'`; `export function nameCategory(name: string): Category`; `export function primaryName(names: string[], preference: NamePreference): string`; `export function aliasNames(names: string[], preference: NamePreference, maxAliases: number): string[]`; `export const MAX_ALIASES = 5`.
- Consumes: `NamePreference` from `../api`.
- This task ports the policy the spec defines; Task 2 writes the same policy in Python and Task 3 pins the two against each other.

- [ ] **Step 1: Write the failing tests**

`frontend/src/editor/names.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { aliasNames, nameCategory, primaryName } from './names'

describe('nameCategory', () => {
  it.each([
    ['M 42', 'messier'],
    ['M42', 'messier'],
    ['Messier 31', 'messier'],
    ['C 14', 'caldwell'],
    ['Caldwell 14', 'caldwell'],
    ['Sh2-279', 'sharpless'],
    ['Sh 2-279', 'sharpless'],
    ['Sharpless 279', 'sharpless'],
    ['B 33', 'barnard'],
    ['Barnard 33', 'barnard'],
    ['NGC 1976', 'ngc'],
    ['NGC 2024A', 'ngc'],
    ['IC 434', 'ic'],
    ['Cr 70', 'catalogue'],
    ['Mel 20', 'catalogue'],
    ['Abell 21', 'catalogue'],
    ['LDN 1622', 'catalogue'],
    ['LBN 974', 'catalogue'],
    ['HD 37742', 'star'],
    ['HIP 26727', 'star'],
    ['SAO 132444', 'star'],
    ['BD -02 1338', 'star'],
    ['ι Ori', 'bayer'],
    ['θ1 Ori C', 'bayer'],
    ['c Ori', 'bayer'],
    ['44 Ori', 'flamsteed'],
    ['41 Ori A', 'flamsteed'],
    ['XYZ 12', 'designation'],
    ['Orion Nebula', 'common'],
    ['Hatysa', 'common'],
    ['h Persei Cluster', 'common'],
    ['Horsehead Nebula', 'common'],
  ])('%s → %s', (name, category) => {
    expect(nameCategory(name)).toBe(category)
  })
})

describe('primaryName', () => {
  const orion = ['NGC 1976', 'M 42', 'LBN 974', 'Great Orion Nebula', 'Orion Nebula']
  it('follows the preference and keeps nova order on ties', () => {
    expect(primaryName(orion, 'popular')).toBe('M 42')
    expect(primaryName(orion, 'ngc_ic')).toBe('NGC 1976')
    expect(primaryName(['NGC 1980', 'LBN 977', 'Lower Sword'], 'popular')).toBe('NGC 1980')
    expect(primaryName(['IC 434', 'Sh2-277', 'Horsehead region'], 'popular')).toBe('Sh2-277')
    expect(primaryName(['IC 434', 'Sh2-277'], 'ngc_ic')).toBe('IC 434')
    expect(primaryName(['Mel 22', 'M 45', 'Pleiades'], 'ngc_ic')).toBe('M 45')
    expect(primaryName(['ι Ori / 44 Ori', 'Hatysa'], 'popular')).toBe('Hatysa')
    expect(primaryName(['Mintaka'], 'popular')).toBe('Mintaka')
  })
})

describe('aliasNames', () => {
  const orion = ['NGC 1976', 'M 42', 'LBN 974', 'Great Orion Nebula', 'Orion Nebula']
  it('puts common names first, drops nested ones, then designations in ranking order, capped', () => {
    expect(aliasNames(orion, 'popular', 2)).toEqual(['Great Orion Nebula', 'NGC 1976'])
    expect(aliasNames(orion, 'popular', 5)).toEqual(['Great Orion Nebula', 'NGC 1976', 'LBN 974'])
    expect(aliasNames(orion, 'ngc_ic', 2)).toEqual(['Great Orion Nebula', 'M 42'])
    expect(aliasNames(['Mel 22', 'M 45', 'Pleiades'], 'popular', 2)).toEqual(['Pleiades', 'Mel 22'])
  })
  it('drops star ids and unknown abbreviations only when a better alias exists', () => {
    expect(aliasNames(['ζ Ori', 'Alnitak', 'HD 37742', 'HIP 26727'], 'popular', 5)).toEqual(['ζ Ori'])
    expect(aliasNames(['HD 37742', 'HIP 26727'], 'popular', 5)).toEqual(['HIP 26727'])
    expect(aliasNames(['XYZ 12', 'ABC 3'], 'popular', 5)).toEqual(['ABC 3'])
  })
  it('caps at zero and keeps nova order within a category', () => {
    expect(aliasNames(orion, 'popular', 0)).toEqual([])
    expect(aliasNames(['NGC 1', 'Alpha', 'Beta', 'Gamma'], 'popular', 5)).toEqual(['Alpha', 'Beta', 'Gamma'])
  })
  it('nesting is case-insensitive and whole-string', () => {
    expect(aliasNames(['NGC 1', 'the Witch Head Nebula', 'WITCH HEAD NEBULA'], 'popular', 5)).toEqual([
      'the Witch Head Nebula',
    ])
    expect(aliasNames(['NGC 1', 'Eyes', 'Eyes Galaxy'], 'popular', 5)).toEqual(['Eyes Galaxy'])
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd frontend && npx vitest run src/editor/names.test.ts`
Expected: FAIL — cannot resolve `./names`.

- [ ] **Step 3: Write the port**

`frontend/src/editor/names.ts` — a line-by-line port of `backend/app/models.py` (`_STAR_CATALOGUES` … `primary_name`) plus the alias policy the spec defines:

```ts
// Catalogue-name classification, primary-name ranking and the alias line (SPEC § 6.2, design
// spec § B). Line-by-line port of backend/app/models.py (name_category, primary_name,
// alias_names): both renderers must build the same two lines from the same catalog_names, and
// tests/fixtures/names/vectors.json (make names-vectors) pins this module to the Python original.

import type { NamePreference } from '../api'

export type Category =
  | 'messier'
  | 'caldwell'
  | 'sharpless'
  | 'barnard'
  | 'ngc'
  | 'ic'
  | 'catalogue'
  | 'designation'
  | 'common'
  | 'bayer'
  | 'flamsteed'
  | 'star'

/** StyleConfig.max_aliases upper bound (models.MAX_ALIASES). */
export const MAX_ALIASES = 5

const STAR_CATALOGUES = new Set([
  'HD', 'HIP', 'SAO', 'TYC', 'HR', 'BD', 'CD', 'CPD', 'GSC', 'GAIA', 'UCAC', 'TIC', 'PPM', 'GJ', 'GL',
  'WDS', 'ADS', 'HIC',
])
const DSO_CATALOGUES = new Set([
  'CR', 'COLLINDER', 'MEL', 'MELOTTE', 'TR', 'TRUMPLER', 'STOCK', 'KING', 'BERKELEY', 'BE', 'RU',
  'RUPRECHT', 'LDN', 'LBN', 'VDB', 'CED', 'CEDERBLAD', 'RCW', 'GUM', 'ARP', 'HCG', 'HICKSON', 'MRK',
  'PK', 'PNG', 'MINKOWSKI', 'JONES', 'KOHOUTEK', 'UGC', 'PGC', 'ESO', 'MCG', 'DDO', 'HOLMBERG', 'SNR',
  'CTB', 'DWB', 'VV', 'AM', 'PAL', 'PALOMAR', 'TERZAN', 'PISMIS', 'WESTERLUND', 'BASEL', 'HAFFNER',
  'BOCHUM', 'CZERNIK', 'DOLIDZE', 'ROSLUND', 'HARVARD', 'ABELL',
])
// Python's re.fullmatch(..., IGNORECASE) is ^…$ with the i flag.
const NAME_PATTERNS: [Category, RegExp][] = [
  ['messier', /^(?:M|Messier)\s?\d+[a-z]?$/i],
  ['caldwell', /^(?:C|Caldwell)\s?\d+$/i],
  ['sharpless', /^(?:Sh\s?2|Sharpless)\s?-?\s?\d+[a-z]?$/i],
  ['barnard', /^(?:B|Barnard)\s?\d+[a-z]?$/i],
  ['ngc', /^NGC\s?\d+[a-z]?$/i],
  ['ic', /^IC\s?\d+[a-z]?$/i],
]
// Python's re.match anchors at the start only.
const DESIGNATION = /^([A-Za-z]+)\s?-?\s?[+-]?\d/
// "ι Ori", "θ1 Ori C", "c Ori": one Greek or Latin letter, optional index, constellation, component
const BAYER = /^[A-Za-zͰ-Ͽ]\d?\s[A-Z][A-Za-z]{2}(?:\s[A-Z])?$/
// "44 Ori", "41 Ori A"
const FLAMSTEED = /^\d{1,3}\s[A-Z][A-Za-z]{2}(?:\s[A-Z])?$/

const RANKING: Record<NamePreference, Category[]> = {
  popular: ['messier', 'caldwell', 'sharpless', 'barnard', 'ngc', 'ic', 'catalogue', 'designation', 'common', 'bayer', 'flamsteed', 'star'],
  ngc_ic: ['ngc', 'ic', 'messier', 'caldwell', 'sharpless', 'barnard', 'catalogue', 'designation', 'common', 'bayer', 'flamsteed', 'star'],
}

/** Classify a catalogue name (models.name_category). */
export function nameCategory(name: string): Category {
  const n = name.trim()
  for (const [category, pattern] of NAME_PATTERNS) if (pattern.test(n)) return category
  if (FLAMSTEED.test(n)) return 'flamsteed'
  if (BAYER.test(n)) return 'bayer'
  const m = DESIGNATION.exec(n)
  if (m) {
    const prefix = m[1]!.toUpperCase()
    if (STAR_CATALOGUES.has(prefix)) return 'star'
    if (DSO_CATALOGUES.has(prefix)) return 'catalogue'
    return 'designation'
  }
  return 'common'
}

/** Names with their nova index, sorted by `key` and then by index (Python's tuple sort). */
function ranked(names: string[], key: (name: string) => number): string[] {
  return names
    .map((name, index) => ({ name, index, rank: key(name) }))
    .sort((a, b) => a.rank - b.rank || a.index - b.index)
    .map((r) => r.name)
}

/** The label's primary line; ties keep nova's original order (models.primary_name). */
export function primaryName(names: string[], preference: NamePreference): string {
  const order = RANKING[preference]
  return ranked(names, (n) => order.indexOf(nameCategory(n)))[0]!
}

/** The alias line, in order and capped (models.alias_names, design spec § B):
 *  1. the primary is dropped;
 *  2. star-catalogue ids and unknown abbreviations are dropped when a better alias exists;
 *  3. a common name contained in another common name of the same object is dropped;
 *  4. common names first in nova's order, then the rest in the primary ranking order;
 *  5. the first `maxAliases` survive. */
export function aliasNames(names: string[], preference: NamePreference, maxAliases: number): string[] {
  const primary = primaryName(names, preference)
  let rest = names.filter((n) => n !== primary)
  const category = new Map(rest.map((n) => [n, nameCategory(n)]))
  const weak = (n: string) => category.get(n) === 'star' || category.get(n) === 'designation'
  if (rest.some((n) => !weak(n))) rest = rest.filter((n) => !weak(n))
  const commons = rest.filter((n) => category.get(n) === 'common')
  const nested = (n: string) =>
    category.get(n) === 'common' && commons.some((o) => o !== n && o.toLowerCase().includes(n.toLowerCase()))
  rest = rest.filter((n) => !nested(n))
  const order = RANKING[preference]
  const key = (n: string) => (category.get(n) === 'common' ? 0 : 1 + order.indexOf(category.get(n)!))
  return ranked(rest, key).slice(0, maxAliases)
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd frontend && npx vitest run src/editor/names.test.ts && npx tsc --noEmit && npx eslint src/editor`
Expected: PASS, clean. (eslint may want the long `RANKING` lines wrapped; wrap them.)

- [ ] **Step 5: Commit**

```bash
git add frontend/src/editor/names.ts frontend/src/editor/names.test.ts
git commit -m "feat(editor): port catalogue-name ranking and the alias policy to TypeScript"
```

---

### Task 2: The contract change on both renderers — `alias_names`, `max_aliases`, `labelText`, render vectors

This is one task on purpose: the CLAUDE.md hard rule says a renderer change lands with its twin and the regenerated contract. Every step's suite is named; the whole set is green at the commit.

**Files:**
- Modify: `backend/app/models.py` (after `primary_name`; `SolveObject.aliases_for`; `StyleConfig`; `StyleDefaults`; `StyleOverrides`)
- Modify: `backend/app/render.py:88-95` (`label_text`)
- Modify: `backend/scripts/make_render_vectors.py` (`GLYPH_STRINGS`, `label_strings`, `label_vectors`)
- Modify: `frontend/src/api.ts` (`StyleConfig`, `StyleDefaults`)
- Modify: `frontend/src/editor/metrics.ts:66-79` (`labelText`)
- Modify: `frontend/src/editor/testDoc.ts:41-54`, `frontend/src/pages/labelPreview.test.ts:8-16`, `frontend/src/pages/configForm.test.ts` (style literals gain `max_aliases`)
- Regenerate: `tests/fixtures/render/vectors.json` (`make render-vectors`)
- Test: `backend/tests/test_objects.py`, `backend/tests/test_config_api.py`, `frontend/src/editor/metrics.test.ts` (existing replay), `backend/tests/test_render_parity.py` (existing)

**Interfaces:**
- Produces (Python): `MAX_ALIASES = 5`, `DEFAULT_MAX_ALIASES = 2`; `def alias_names(names: list[str], preference: NamePreference = "popular", max_aliases: int = DEFAULT_MAX_ALIASES) -> list[str]`; `SolveObject.aliases_for(self, preference="popular", max_aliases=DEFAULT_MAX_ALIASES)`; `StyleConfig.max_aliases: int = Field(default=DEFAULT_MAX_ALIASES, ge=0, le=MAX_ALIASES)`; same optional field on `StyleOverrides`; `StyleDefaults.max_aliases: int`.
- Produces (TS): `StyleConfig.max_aliases: number`, `StyleDefaults.max_aliases: number`; `labelText(obj, label, style)` now derives both lines from `obj.catalog_names` through `names.ts`.
- Consumes: `primaryName`, `aliasNames` from Task 1.

- [ ] **Step 1: Write the failing Python tests**

Append to `backend/tests/test_objects.py` (import `alias_names` alongside `name_category, primary_name`):

```python
ORION = ["NGC 1976", "M 42", "LBN 974", "Great Orion Nebula", "Orion Nebula"]


def test_alias_line_common_first_nested_dropped_then_ranking_order_capped() -> None:
    assert alias_names(ORION, "popular", 2) == ["Great Orion Nebula", "NGC 1976"]
    assert alias_names(ORION, "popular", 5) == ["Great Orion Nebula", "NGC 1976", "LBN 974"]
    assert alias_names(ORION, "ngc_ic", 2) == ["Great Orion Nebula", "M 42"]
    assert alias_names(["Mel 22", "M 45", "Pleiades"], "popular", 2) == ["Pleiades", "Mel 22"]
    assert alias_names(ORION, "popular", 0) == []


def test_alias_line_drops_star_ids_and_unknown_abbreviations_only_when_something_better_exists() -> None:
    assert alias_names(["ζ Ori", "Alnitak", "HD 37742", "HIP 26727"], "popular", 5) == ["ζ Ori"]
    assert alias_names(["HD 37742", "HIP 26727"], "popular", 5) == ["HIP 26727"]
    assert alias_names(["XYZ 12", "ABC 3"], "popular", 5) == ["ABC 3"]


def test_alias_line_nesting_is_case_insensitive_and_whole_string() -> None:
    assert alias_names(["NGC 1", "the Witch Head Nebula", "WITCH HEAD NEBULA"], "popular", 5) == [
        "the Witch Head Nebula"
    ]
    assert alias_names(["NGC 1", "Eyes", "Eyes Galaxy"], "popular", 5) == ["Eyes Galaxy"]
    assert alias_names(["NGC 1", "Alpha", "Beta", "Gamma"], "popular", 5) == ["Alpha", "Beta", "Gamma"]


def test_solve_object_alias_line_uses_the_policy() -> None:
    obj = SolveObject(id=1, catalog_names=ORION, type="ngc", x=0, y=0, radius=1)
    assert obj.aliases_for("popular", 2) == ["Great Orion Nebula", "NGC 1976"]
    assert obj.aliases == ["Great Orion Nebula", "NGC 1976"]


def test_max_aliases_bounds() -> None:
    assert StyleConfig().max_aliases == 2
    assert StyleConfig(max_aliases=0).max_aliases == 0
    with pytest.raises(ValidationError):
        StyleConfig(max_aliases=6)
    with pytest.raises(ValidationError):
        StyleOverrides(max_aliases=-1)
```

(Import `SolveObject`, `StyleConfig`, `StyleOverrides` from `app.models` and `ValidationError` from `pydantic`.)

In `backend/tests/test_config_api.py`, inside `test_default_style_is_validated_and_stored_as_overrides`, extend the `ok` PUT body with `"max_aliases": 3` and both expected dicts with `"max_aliases": 3`; add after the empty-set line:

```python
        too_many = client.put("/api/config", json={"default_style": {"max_aliases": 9}})
        assert too_many.status_code == 422 and "9" not in too_many.text
        assert client.get("/api/config").json()["style_defaults"]["max_aliases"] == 2
```

- [ ] **Step 2: Run them to verify they fail**

Run: `cd backend && .venv/bin/pytest tests/test_objects.py tests/test_config_api.py -q`
Expected: FAIL — `alias_names` cannot be imported; `max_aliases` is refused by `extra="forbid"`.

- [ ] **Step 3: Python — the policy and the field**

In `backend/app/models.py`, right after `primary_name`:

```python
DEFAULT_MAX_ALIASES = 2
MAX_ALIASES = 5


def alias_names(
    names: list[str], preference: NamePreference = "popular", max_aliases: int = DEFAULT_MAX_ALIASES
) -> list[str]:
    """The alias line, in order and capped (SPEC § 6.2):

    1. the primary is dropped;
    2. star-catalogue ids and unknown abbreviations are dropped when a better alias exists;
    3. a common name contained in another common name of the same object is dropped
       (case-insensitive, whole string: "Orion Nebula" inside "Great Orion Nebula");
    4. common names first in nova's order, then the rest in the primary-name ranking order;
    5. the first ``max_aliases`` survive.

    ``frontend/src/editor/names.ts`` is a line-by-line port; ``make names-vectors`` pins the two.
    """
    primary = primary_name(names, preference)
    rest = [n for n in names if n != primary]
    category = {n: name_category(n) for n in rest}
    weak = {"star", "designation"}
    if any(category[n] not in weak for n in rest):
        rest = [n for n in rest if category[n] not in weak]
    commons = [n for n in rest if category[n] == "common"]

    def nested(n: str) -> bool:
        return category[n] == "common" and any(o != n and n.lower() in o.lower() for o in commons)

    rest = [n for n in rest if not nested(n)]
    order = _RANKING[preference]
    ranked = sorted(
        enumerate(rest),
        key=lambda kv: (0 if category[kv[1]] == "common" else 1 + order.index(category[kv[1]]), kv[0]),
    )
    return [n for _, n in ranked][:max_aliases]
```

`alias_names` is defined after `SolveObject` in the file today (the naming helpers sit below the model): move nothing, Python resolves the name at call time. Change `SolveObject.aliases_for`:

```python
    def aliases_for(
        self, preference: NamePreference = "popular", max_aliases: int = DEFAULT_MAX_ALIASES
    ) -> list[str]:
        return alias_names(self.catalog_names, preference, max_aliases)
```

`StyleConfig`: after `show_aliases`, add `max_aliases: int = Field(default=DEFAULT_MAX_ALIASES, ge=0, le=MAX_ALIASES)` and extend the docstring with one line: "``max_aliases`` caps the alias line (0 means none)". `StyleOverrides`: `max_aliases: int | None = Field(default=None, ge=0, le=MAX_ALIASES)`. `StyleDefaults`: `max_aliases: int` after `show_aliases` (a test pins its field set against `StyleConfig` minus the size-relative fields; it is not size-relative).

`backend/app/render.py` `label_text`: `aliases = obj.aliases_for(style.name_preference, style.max_aliases)`.

`backend/app/models.py` `VALIDATION_MESSAGES` already words `less_than_equal`/`greater_than_equal` generically; check `too_many` in the test yields a sentence without the value (the existing bound tests for `halo_width` show the pattern). If `max_aliases` needs a field-specific sentence, add it beside the other style fields' entries.

- [ ] **Step 4: Run the Python tests**

Run: `cd backend && .venv/bin/pytest tests/test_objects.py tests/test_config_api.py -q && .venv/bin/ruff check . && .venv/bin/mypy app`
Expected: PASS, clean. `tests/test_render_parity.py` is now red (alias lines changed); Step 7 fixes it.

- [ ] **Step 5: Frontend types, `labelText`, literals**

`frontend/src/api.ts`: add `max_aliases: number` after `show_aliases` in both `StyleConfig` and `StyleDefaults`.

`frontend/src/editor/metrics.ts`: replace `labelText` and its comment:

```ts
/** Both lines from the object's raw names and the *store's* style (names.ts): a preference or
 *  cap change re-measures at once, and the export builds the same lines from the same rules
 *  (#64). `obj.primary_name` is the server's ranking at fetch time, kept for the Objects tab. */
export function labelText(obj: ObjectOut, label: Label, style: StyleConfig): LabelLines {
  const override = (label.text_override ?? '').trim()
  const primary = override || primaryName(obj.catalog_names, style.name_preference)
  const show = label.show_aliases ?? style.show_aliases
  const aliases = show ? aliasNames(obj.catalog_names, style.name_preference, style.max_aliases) : []
  return { primary, alias: aliases.length > 0 ? aliases.join(ALIAS_SEP) : null }
}
```

with `import { aliasNames, primaryName } from './names'`.

Add `max_aliases: 2` to the `StyleConfig` literal in `frontend/src/editor/testDoc.ts`, to the `StyleDefaults` literal in `frontend/src/pages/labelPreview.test.ts`, and wherever `configForm.test.ts` builds a `StyleDefaults`/`ConfigOut` (grep `name_preference: 'popular'`).

Run: `cd frontend && npx tsc --noEmit`
Expected: clean (every literal updated). `metrics.test.ts` is red until Step 7.

- [ ] **Step 6: The render-vectors generator**

In `backend/scripts/make_render_vectors.py`:

- `GLYPH_STRINGS`: replace `"M 42 · LBN 974 · Great Orion Nebula · Orion Nebula"` with the two lines the policy now produces for M 42: `"Great Orion Nebula · NGC 1976"` and `"Great Orion Nebula · NGC 1976 · LBN 974"` (`test_glyph_strings_are_real_fixture_labels` requires every glyph string to be a real fixture label under some case).
- `label_strings`: iterate `max_aliases in (DEFAULT_MAX_ALIASES, MAX_ALIASES)` as well as both preferences (`StyleConfig(name_preference=preference, max_aliases=max_aliases)`), importing the two constants from `app.models`.
- `label_vectors`: the `other` style gains `"max_aliases": MAX_ALIASES` in its `model_copy(update=...)`, and its docstring mentions the cap, so the label cases cover a five-alias line.

- [ ] **Step 7: Regenerate and replay**

Run from the repo root: `make render-vectors` then `cd backend && .venv/bin/pytest tests/test_render_parity.py -q` and `cd frontend && npx vitest run src/editor && npx eslint src`.
Expected: the generator prints the new counts; pytest PASS; vitest PASS including `metrics.test.ts` "reproduces every label box, text, marker radius and ascent" (the TS `labelText` now agrees with Python's `label_text` on every case). If a label case disagrees, the port and the policy differ: fix `names.ts`, never the vectors.

`git diff --stat tests/fixtures/render/vectors.json` should show changed alias strings only in `texts` and `labels`; `leaders` and `anchors` are byte-identical.

- [ ] **Step 8: Full suites and the browser parity diff**

Run: `make lint test` then `make e2e`.
Expected: all green, including `frontend/e2e/parity.spec.ts` (both renderers draw the new alias lines).

- [ ] **Step 9: Commit**

```bash
git add backend/app/models.py backend/app/render.py backend/scripts/make_render_vectors.py backend/tests/test_objects.py backend/tests/test_config_api.py frontend/src/api.ts frontend/src/editor/metrics.ts frontend/src/editor/testDoc.ts frontend/src/pages/labelPreview.test.ts frontend/src/pages/configForm.test.ts tests/fixtures/render/vectors.json
git commit -m "feat: alias line policy and max_aliases on both renderers, render vectors regenerated"
```

---

### Task 3: Names vectors — the contract between the port and the original

**Files:**
- Create: `backend/scripts/make_names_vectors.py`
- Create: `tests/fixtures/names/vectors.json` (generated)
- Create: `backend/tests/test_names_vectors.py`
- Modify: `frontend/src/editor/names.test.ts` (replay)
- Modify: `Makefile` (`names-vectors` target and `.PHONY`), `CLAUDE.md` (Commands block)

**Interfaces:**
- Vector file shape: `{"cases": [{"names": [...], "categories": [...], "popular": {"primary": "...", "aliases": {"0": [...], "1": [...], "2": [...], "3": [...], "4": [...], "5": [...]}}, "ngc_ic": {...}}]}`. One case per distinct `catalog_names` list from both nova fixtures (through `objects_from_nova`, so OpenNGC-enriched names are included) plus the hand-written `EDGE_CASES`.
- Consumes: `alias_names`, `primary_name`, `name_category`, `MAX_ALIASES` (Task 2); `nameCategory`, `primaryName`, `aliasNames` (Task 1).

- [ ] **Step 1: Write the generator**

`backend/scripts/make_names_vectors.py`:

```python
"""(Re)generate tests/fixtures/names/vectors.json: the name ranking and alias line the
TypeScript port must reproduce.

For every distinct catalogue-name list in both nova fixtures (OpenNGC-enriched, as the objects
table stores them) and a hand-written edge set, the file records each name's category and, under
both preferences, the primary line and the alias line at every cap 0..MAX_ALIASES.
``tests/test_names_vectors.py`` (models.py must still produce it) and
``frontend/src/editor/names.test.ts`` (the port) replay it. Run from backend/:
python scripts/make_names_vectors.py   (``make names-vectors``)
"""

from __future__ import annotations

import json
import sys
from pathlib import Path
from typing import Any

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from app.config import REPO_ROOT
from app.models import MAX_ALIASES, NamePreference, alias_names, name_category, primary_name
from app.objects import objects_from_nova

OUT = REPO_ROOT / "tests" / "fixtures" / "names" / "vectors.json"
FIXTURES = (
    REPO_ROOT / "backend" / "tests" / "fixtures" / "nova",
    REPO_ROOT / "backend" / "tests" / "fixtures" / "nova-narrow",
)
PREFERENCES: tuple[NamePreference, ...] = ("popular", "ngc_ic")

# Shapes the fixtures do not contain: Greek and Latin Bayer letters with and without a
# component, Flamsteed numbers, HD/HIP twins with and without a proper name, unknown prefixes,
# nested and case-variant common names, stray whitespace, a lone star id, every cap edge.
EDGE_CASES: tuple[list[str], ...] = (
    ["NGC 1976", "M 42", "LBN 974", "Great Orion Nebula", "Orion Nebula"],
    ["Mel 22", "M 45", "Pleiades"],
    ["NGC 6618", "M 17", "LBN 60", "Checkmark Nebula", "Lobster Nebula", "Swan Nebula", "omega Nebula"],
    ["ζ Ori", "Alnitak", "HD 37742", "HIP 26727"],
    ["HD 37742", "HIP 26727"],
    ["HD 198639"],
    ["XYZ 12", "ABC 3"],
    ["θ1 Ori C", "41 Ori C", "HD 37022"],
    ["ι Ori / 44 Ori", "Hatysa"],
    ["c Ori", "42 Ori", "Mizan Batil I"],
    ["NGC 1", "the Witch Head Nebula", "WITCH HEAD NEBULA"],
    ["NGC 1", "Eyes", "Eyes Galaxy"],
    ["NGC 1", "Alpha", "Beta", "Gamma", "Delta", "Epsilon", "Zeta"],
    [" NGC 2024 ", "Flame Nebula", "Sh2-277"],
    ["IC 434", "Sh2-277", "Horsehead region"],
    ["B 33", "Horsehead Nebula", "LDN 1630"],
    ["C 14", "NGC 869", "h Persei Cluster", "Cr 24"],
    ["Messier 31", "NGC 224", "Andromeda Galaxy", "UGC 454", "PGC 2557"],
    ["Mintaka"],
)


def name_lists() -> list[list[str]]:
    seen: set[tuple[str, ...]] = set()
    out: list[list[str]] = []
    for names in list(EDGE_CASES) + [
        obj.catalog_names
        for fixtures_dir in FIXTURES
        for obj in objects_from_nova(
            json.loads((fixtures_dir / "annotations.json").read_text(encoding="utf-8"))["annotations"],
            1.0,
        )
    ]:
        key = tuple(names)
        if key in seen:
            continue
        seen.add(key)
        out.append(list(names))
    return out


def case(names: list[str]) -> dict[str, Any]:
    doc: dict[str, Any] = {"names": names, "categories": [name_category(n) for n in names]}
    for preference in PREFERENCES:
        doc[preference] = {
            "primary": primary_name(names, preference),
            "aliases": {str(cap): alias_names(names, preference, cap) for cap in range(MAX_ALIASES + 1)},
        }
    return doc


def build_vectors() -> dict[str, Any]:
    return {"max_aliases": MAX_ALIASES, "cases": [case(names) for names in name_lists()]}


def dump(doc: dict[str, Any]) -> str:
    """One case per line, so a diff shows which object changed."""
    lines = ["{", f' "max_aliases": {doc["max_aliases"]},', ' "cases": [']
    cases = doc["cases"]
    for i, item in enumerate(cases):
        sep = "," if i < len(cases) - 1 else ""
        lines.append(f"  {json.dumps(item, ensure_ascii=False, separators=(',', ':'))}{sep}")
    lines += [" ]", "}"]
    return "\n".join(lines) + "\n"


def main() -> None:
    doc = build_vectors()
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(dump(doc), encoding="utf-8")
    print(f"wrote {OUT.relative_to(REPO_ROOT)}: {len(doc['cases'])} cases")


if __name__ == "__main__":
    main()
```

- [ ] **Step 2: Makefile and CLAUDE.md**

Makefile, after the `render-vectors` target:

```make
names-vectors: $(VENV)/.installed ## Regenerate tests/fixtures/names/vectors.json from models.py (name ranking + alias line, pins the TypeScript port)
	cd backend && .venv/bin/python scripts/make_names_vectors.py
```

Add `names-vectors` to the `.PHONY` list. In `CLAUDE.md`'s Commands block, after the `make render-vectors` line: `make names-vectors       # regenerate tests/fixtures/names/vectors.json from models.py (name ranking + alias line)`. In the hard-rules bullet about the render contract, after "`frontend/src/editor/metrics.ts` (pinned by `metrics.test.ts`) must be changed to match," add: "the name ranking and alias policy are pinned the same way by `make names-vectors` (`tests/fixtures/names/vectors.json`, replayed by `backend/tests/test_names_vectors.py` and `frontend/src/editor/names.test.ts`),".

- [ ] **Step 3: Generate**

Run: `make names-vectors`
Expected: `wrote tests/fixtures/names/vectors.json: N cases` with N around 45. Open the file and check the M 42 case reads `"popular":{"primary":"M 42","aliases":{"0":[],"1":["Great Orion Nebula"],"2":["Great Orion Nebula","NGC 1976"],...`.

- [ ] **Step 4: The pytest replay (write it, watch it pass, then break it to see it fail)**

`backend/tests/test_names_vectors.py`:

```python
"""tests/fixtures/names/vectors.json must be what models.py produces today.

A failure means the ranking or the alias policy changed: check the diff, then
``make names-vectors`` and commit the file with the change that caused it — and change
``frontend/src/editor/names.ts`` to match (``names.test.ts`` replays the same file)."""

from __future__ import annotations

import json
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPO_ROOT / "backend"))

from scripts.make_names_vectors import EDGE_CASES, OUT, build_vectors  # noqa: E402


def test_names_vectors_are_current() -> None:
    assert OUT.exists(), "run make names-vectors"
    assert json.loads(OUT.read_text(encoding="utf-8")) == build_vectors(), (
        "vectors.json is stale: run make names-vectors and commit it with the change"
    )


def test_edge_cases_cover_the_policy_rules() -> None:
    """Every rule has at least one case that exercises it: a nested common name, a star twin, a
    lone star id, an unknown prefix, more common names than the cap."""
    flat = [tuple(c) for c in EDGE_CASES]
    assert ("NGC 1976", "M 42", "LBN 974", "Great Orion Nebula", "Orion Nebula") in flat
    assert ("HD 37742", "HIP 26727") in flat
    assert ("XYZ 12", "ABC 3") in flat
    assert any(len(c) > 6 for c in flat)
```

Run: `cd backend && .venv/bin/pytest tests/test_names_vectors.py -q` → PASS. Then prove the replay bites: temporarily comment out the nested-name filter line in `alias_names` (`rest = [n for n in rest if not nested(n)]`), run again → the first test FAILS with the "stale" message; revert. The `sys.path` / import preamble mirrors `tests/test_render_parity.py`; copy its exact form if it differs.

- [ ] **Step 5: The vitest replay**

Append to `frontend/src/editor/names.test.ts` (import `raw from '../../../tests/fixtures/names/vectors.json'` at the top, as `metrics.test.ts` imports the render vectors):

```ts
interface NamesVectors {
  max_aliases: number
  cases: {
    names: string[]
    categories: string[]
    popular: { primary: string; aliases: Record<string, string[]> }
    ngc_ic: { primary: string; aliases: Record<string, string[]> }
  }[]
}
const vectors = raw as unknown as NamesVectors

describe('names vectors', () => {
  it('loaded the contract the Python side generated', () => {
    expect(vectors.max_aliases).toBe(MAX_ALIASES)
    expect(vectors.cases.length).toBeGreaterThan(20)
  })
  it('reproduces every category, primary line and alias line at every cap', () => {
    for (const c of vectors.cases) {
      expect(c.names.map(nameCategory), c.names.join(' | ')).toEqual(c.categories)
      for (const preference of ['popular', 'ngc_ic'] as const) {
        expect(primaryName(c.names, preference), `${preference}: ${c.names.join(' | ')}`).toBe(c[preference].primary)
        for (let cap = 0; cap <= vectors.max_aliases; cap++) {
          expect(aliasNames(c.names, preference, cap), `${preference} cap ${cap}: ${c.names.join(' | ')}`).toEqual(
            c[preference].aliases[String(cap)],
          )
        }
      }
    }
  })
})
```

Add `MAX_ALIASES` to the import from `./names`.

Run: `cd frontend && npx vitest run src/editor/names.test.ts && npx tsc --noEmit && npx eslint src/editor`
Expected: PASS, clean. A failing case names the list and preference; fix `names.ts`, never the vectors.

- [ ] **Step 6: Commit**

```bash
git add backend/scripts/make_names_vectors.py backend/tests/test_names_vectors.py tests/fixtures/names/vectors.json frontend/src/editor/names.test.ts Makefile CLAUDE.md
git commit -m "test: names vectors pin the TypeScript port to the Python ranking and alias policy"
```

---

### Task 4: Config page — `max_aliases` field, the dropdown without its duplicate, preview lines

**Files:**
- Modify: `frontend/src/pages/configForm.ts` (`StyleForm`, both converters; new `PREFERENCE_LABELS`, `otherPreference`)
- Modify: `frontend/src/pages/ConfigPage.tsx:7-8` (`SizeKey`), `:214-223` (dropdown), field list
- Modify: `frontend/src/pages/labelPreview.ts` (`LINES`, `previewLines`), `frontend/src/pages/LabelPreview.tsx:54-56`
- Test: `frontend/src/pages/configForm.test.ts`, `frontend/src/pages/labelPreview.test.ts`

**Interfaces:**
- Produces: `StyleForm.max_aliases: string` (blank = default); `export const PREFERENCE_LABELS: Record<NamePreference, string>`; `export function otherPreference(p: NamePreference): NamePreference`; `previewLines(preference: '' | NamePreference, fallback: NamePreference, maxAliases: number): { primary: string; aliases: string }`.
- Consumes: `StyleDefaults.max_aliases` (Task 2).

- [ ] **Step 1: Write the failing tests**

`configForm.test.ts` — add inside the existing describe:

```ts
  it('round-trips max_aliases and drops it when blank', () => {
    expect(styleFormFromOverrides({ max_aliases: 3 }).max_aliases).toBe('3')
    expect(overridesFromStyleForm({ ...styleFormFromOverrides({}), max_aliases: '0' })).toEqual({ max_aliases: 0 })
    expect(overridesFromStyleForm({ ...styleFormFromOverrides({}), max_aliases: '' })).toEqual({})
  })

  it('names the other preference and labels both', () => {
    expect(otherPreference('popular')).toBe('ngc_ic')
    expect(otherPreference('ngc_ic')).toBe('popular')
    expect(PREFERENCE_LABELS.popular).toContain('Messier')
    expect(PREFERENCE_LABELS.ngc_ic).toContain('NGC')
  })
```

`labelPreview.test.ts` — replace the "puts the preferred catalogue first" test:

```ts
  it('builds the sample lines from the alias policy and the cap', () => {
    expect(previewLines('', 'popular', 2)).toEqual({ primary: 'M 42', aliases: 'Great Orion Nebula · NGC 1976' })
    expect(previewLines('', 'ngc_ic', 2)).toEqual({ primary: 'NGC 1976', aliases: 'Great Orion Nebula · M 42' })
    expect(previewLines('ngc_ic', 'popular', 5).aliases).toBe('Great Orion Nebula · M 42 · LBN 974')
    expect(previewLines('popular', 'popular', 1).aliases).toBe('Great Orion Nebula')
    expect(previewLines('popular', 'popular', 0).aliases).toBe('')
  })
```

- [ ] **Step 2: Run them to verify they fail**

Run: `cd frontend && npx vitest run src/pages`
Expected: FAIL — `max_aliases` missing from the form, `otherPreference`/`PREFERENCE_LABELS` not exported, `previewLines` ignores its third argument.

- [ ] **Step 3: Implement**

`configForm.ts`: add `max_aliases: string` to `StyleForm` after `show_aliases`; `max_aliases: str(o.max_aliases)` in `styleFormFromOverrides`; `max_aliases: num(f.max_aliases)` in `overridesFromStyleForm`. Add:

```ts
/** The dropdown wording for each name preference (SPEC § 6.3). */
export const PREFERENCE_LABELS: Record<NamePreference, string> = {
  popular: 'Messier, Caldwell, Sharpless, Barnard first',
  ngc_ic: 'NGC and IC first',
}

/** The one value that differs from `p`: the only explicit choice the config page offers (#73). */
export function otherPreference(p: NamePreference): NamePreference {
  return p === 'popular' ? 'ngc_ic' : 'popular'
}
```

`labelPreview.ts`: use the real policy so the sample can never drift from the rules:

```ts
import { aliasNames, primaryName } from '../editor/names'

/** One object, both ways round: M 42's real name list through the same ranking and alias
 *  policy the renderers use, so the sample tracks the rules (SPEC § 6.2). */
const SAMPLE = ['NGC 1976', 'M 42', 'LBN 974', 'Great Orion Nebula', 'Orion Nebula']

export function previewLines(preference: '' | NamePreference, fallback: NamePreference, maxAliases: number) {
  const p = preference || fallback
  return { primary: primaryName(SAMPLE, p), aliases: aliasNames(SAMPLE, p, maxAliases).join(ALIAS_SEP) }
}
```

(import `ALIAS_SEP` from `../editor/metrics` next to the existing `ALIAS_SCALE, LINE_HEIGHT`; delete the old `LINES` table.)

`LabelPreview.tsx`: `const maxAliases = Number(style.max_aliases) || defaults.max_aliases` (blank → default; note `Number('0')` is 0 and falsy, so use `style.max_aliases.trim() === '' ? defaults.max_aliases : Number(style.max_aliases)`), then `previewLines(style.name_preference, defaults.name_preference, maxAliases)`; `aliasesOn` becomes `aliasesOn && lines.aliases !== ''`.

`ConfigPage.tsx`: add `'max_aliases'` to `SizeKey`; after `{triField('Alias line', 'show_aliases')}` add `{sizeField('Aliases shown (max)', 'max_aliases', 0, 5)}`; replace the three `<option>`s of the Primary name select with:

```tsx
              <option value="">Default ({PREFERENCE_LABELS[d.name_preference]})</option>
              {/* A stored override equal to the default keeps an option, so the select is never blank. */}
              {style.name_preference === d.name_preference && (
                <option value={style.name_preference}>{PREFERENCE_LABELS[style.name_preference]} (same as default)</option>
              )}
              <option value={otherPreference(d.name_preference)}>{PREFERENCE_LABELS[otherPreference(d.name_preference)]}</option>
```

importing `PREFERENCE_LABELS, otherPreference` from `./configForm`.

- [ ] **Step 4: Run the tests, types, lint**

Run: `cd frontend && npx vitest run src/pages && npx tsc --noEmit && npx eslint src/pages`
Expected: PASS, clean.

- [ ] **Step 5: Manual check on the dev unit** (owner, at the end; note it in the report): the config page shows "Aliases shown (max)" after "Alias line", the preview alias line shortens as the number drops and vanishes at 0, and the Primary name dropdown offers "Default (Messier, …)" and "NGC and IC first" only.

- [ ] **Step 6: Commit**

```bash
git add frontend/src/pages
git commit -m "feat(config): max aliases field, preview from the real policy, one explicit name-preference choice"
```

---

### Task 5: SPEC.md and the issues' wording

**Files:**
- Modify: `docs/SPEC.md:164-166` (§ 6.2 label bullet), `:202` (§ 6.3 Style tab), `:263` (§ 7 `style` json), `:344-350` (§ 9 contract sentence)

- [ ] **Step 1: § 6.2** — replace the label bullet's alias sentence with:

```
- A **label** (text block): primary name, optional secondary line with aliases. The stored `x, y` is the
  **top-left of the text box**; line height is `ceil(size × 1.2)`; the alias line is set at `0.7 × size`
  (min 6 px) and aliases are joined with ` · `. The alias line follows one policy on both renderers
  (`models.alias_names`, `names.ts`): the primary is dropped; star-catalogue ids (HD, HIP, SAO…) and
  unknown abbreviations are dropped when a better alias exists; a common name contained in another
  common name of the same object is dropped ("Orion Nebula" inside "Great Orion Nebula"); common names
  come first in nova's order, then the rest in the primary-name ranking order; the first `max_aliases`
  (0–5, default 2) survive. M 42 reads "M 42" over "Great Orion Nebula · NGC 1976".
```

- [ ] **Step 2: § 6.3** — in the Style item, after "alias line on/off," insert "max aliases (0–5),". Add to the end of the item: "The config page's name-preference dropdown offers "Default (…)" and the one other value; the Style tab lists both values by name."

- [ ] **Step 3: § 7** — change `style         json  (global StyleConfig)` to `style         json  (global StyleConfig; includes max_aliases since M4)`.

- [ ] **Step 4: § 9** — after the sentence ending "`frontend/src/editor/metrics.test.ts` replay it exactly.", add: "The name ranking and alias policy have their own contract: `make names-vectors` writes `tests/fixtures/names/vectors.json` from `models.py` for every fixture name list and a hand-written edge set, and `backend/tests/test_names_vectors.py` and `frontend/src/editor/names.test.ts` replay it."

- [ ] **Step 5: Verify and commit**

Run: `make lint test`
Expected: green.

```bash
git add docs/SPEC.md
git commit -m "docs: alias policy, max aliases and the names contract in SPEC § 6, 7, 9"
```

---

### Task 6: Review ritual and PR

- [ ] **Step 1:** whole-branch review (`/code-review high` or the SDD final reviewer), fix, `make lint test`.
- [ ] **Step 2:** silent-failure pass on the diff; fix.
- [ ] **Step 3:** `/simplify`; `make lint test` and `make e2e`.
- [ ] **Step 4:** owner's smoke test on the dev unit: open the Orion image, labels read "M 42 / Great Orion Nebula · NGC 1976"; export and compare the alias lines; config page per Task 4 Step 5.
- [ ] **Step 5:** `gh pr create` — title `feat: name ranking port and alias policy on both renderers (milestone 4, PR 2)`; body says `Closes #13`, `Closes #64`, `Closes #73`, names the new `make names-vectors` contract and the regenerated render vectors. `gh pr checks --watch`. Do not merge without the owner's go.
