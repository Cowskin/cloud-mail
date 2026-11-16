---
version: 1
slug: "mail-vue-src-views-setting-index-vue"
primary_target: "mail-vue/src/views/setting/index.vue"
related_targets: ["mail-vue/src/i18n/zh.js","mail-vue/src/i18n/en.js"]
---

# Personal settings: card encryption entry

Historical brief, superseded on 2026-11-16: the user clarified that the entry belongs in system settings. The personal placeholder has been removed; current implementation and review are recorded in the sys-setting surface brief.

Scope: a narrow extension of the existing settings page. Mode: Operate.
The user explicitly requested the first stage only, default off, progress in the plan, and production deployment.

## Direction contract

THESIS: Make the upcoming card protection setting findable while truthfully showing that protection is off and activation is unavailable.

OWN-WORLD: Inherit the existing Vue and Element Plus settings page, system typography, theme variables, and plain stacked sections. No redesign, new visual identity, or decorative assets.

STORY: A signed-in user sees the card encryption setting below account information, reads its disabled state, and understands that current email content remains unchanged.

FIRST VIEWPORT: Preserve account information, insert a compact card encryption section before language selection, pair its label with a disabled off switch and explicit status, and wrap the explanation on mobile. Existing account controls remain in place.

FORM: Existing settings section extension; no concept round applies to this precise request. Signature behavior: the switch stays off on click, keyboard navigation, and reload. Seed reference: none, existing surface extension.

FINISH: unreviewed and undocumented is unfinished; this build ends with the finish review, the verdict, DESIGN.md, and every shipping raster carrying its provenance

Documentation boundary: ordinary extension, no DESIGN.md exists and no visual system change is authorized. Record implementation progress in docs/card-protection-plan.md; preserve incumbent styling. No shipping raster assets.

Finish review: ship, 2026-11-16. Independent review found no material issues in the source and four valid local synthetic-account captures (desktop 1440/1280, mobile Chinese, mobile English dark). Production authentication and assistive technology were not independently verified. Private captures are retained outside source control in .private/card-settings-qa/.
