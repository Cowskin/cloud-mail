---
version: 1
slug: mail-vue-src-views-sys-setting-index-vue
primary_target: mail-vue/src/views/sys-setting/index.vue
related_targets: [mail-vue/src/components/card-protection-settings/index.vue]
---

# System card protection

Scope: extend existing system settings. Mode: Operate. The user corrected the personal settings placement and requested the complete encryption workflow. Default is off; existing system permissions apply. Search/indexing remains deferred.

## Direction contract

THESIS: The administrator manages one site-wide protection policy, with explicit current state and password-authorized changes.

OWN-WORLD: Preserve incumbent Element Plus controls, theme variables, system type, settings card headings and grid. No visual system change or shipping raster assets.

STORY: Read current state; open enable/change/disable inline; enter and confirm required passwords; receive actionable errors or a saved state. Never show stored passwords or keys.

FIRST VIEWPORT: A card in the existing grid after website settings. Heading, state switch, short explanation, change-password action when enabled; inline labeled password form expands below. Mobile follows the existing single-column grid.

FORM: A precise existing-surface extension, code-led. Signature interaction is a non-optimistic switch: status changes only after backend success. Password fields clear when canceled or completed. seed: none (narrow extension).

FINISH: unreviewed and undocumented is unfinished; this build ends with the finish review, the verdict, DESIGN.md, and every shipping raster carrying its provenance

Documentation boundary: no DESIGN.md exists; preserve the incumbent design. Implementation, validation and release progress belong in docs/card-protection-plan.md.

Password rules follow apple_manage_tool: nonempty single line, at most 1024 UTF-8 bytes, case/spaces preserved; there is no eight-character minimum.
Enabling, including after disabling a previously configured policy, asks only for a new password and confirmation. The current password is required only for changing the password or disabling protection.

Finish review (2026-11-16): ship. Independent source and nine-capture review found no material scoped UI issues at 1440/1280/390px, including full Chinese and English dark forms through the incumbent internal scrollbar. Actual local Worker/Vue interactions and 46 workerd tests supplied validation. Production authenticated UI remains outside this evidence. No design-system files or raster assets were changed.
