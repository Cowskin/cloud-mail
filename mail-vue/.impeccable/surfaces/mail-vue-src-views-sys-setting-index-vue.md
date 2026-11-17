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

Webhook extension (updated 2026-11-17): per the user's explicit requirement, system settings display the full saved robot URL in a wrapping textarea, including its robot key. Cryptographic master keys and protection passwords remain private. Saving and reloading retain the URL; unchanged values disable Save. Off state explains the dependency and retains a read-only URL. Preserve existing card spacing, Element Plus controls and bilingual copy. Saving sends no test message. Desktop Chinese and 390px English were verified with a mocked API, including save/reload, retained input on error, conflict reload, off and read-only permissions. Backend permissions, URL sealing and unchanged-save queue preservation are covered separately with workerd tests. No new raster assets or design-system changes.

Release update (2026-11-16 21:43): the same form now supports WeCom and Feishu URLs with automatic provider detection and bilingual labels. Deployed in source 194ae19; a temporary Feishu destination was sealed by the backend service through authorized CLI operations and accepted one synthetic connectivity test. Production authenticated UI interaction remains outside the evidence.

Finish review (2026-11-16): ship. Independent source and nine-capture review found no material scoped UI issues at 1440/1280/390px, including full Chinese and English dark forms through the incumbent internal scrollbar. Actual local Worker/Vue interactions and 46 workerd tests supplied validation. Production authenticated UI remains outside this evidence. No design-system files or raster assets were changed.
