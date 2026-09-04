---
name: Client version baseline
description: Defines how installed Windows client versions are reported and compared with the desired fleet version.
---

Treat the desired client version as the minimum acceptable baseline. A dotted numeric installed version at or above the desired version is current; a lower version is outdated. Missing or malformed reports are unknown, never silently current or outdated.

**Why:** Clients may self-update or report a version with additional numeric components, so exact string equality would create false drift and lexical ordering would misclassify values such as 1.10 versus 1.9.

**How to apply:** Compare dotted numeric components numerically with missing components treated as zero. Keep the service assembly/product version aligned with the MSI version, and keep SCCM as the deployment mechanism until OTA delivery is explicitly introduced.