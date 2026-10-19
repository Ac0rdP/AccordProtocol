# Internationalized Documentation (i18n)

This directory contains localized versions of Accord Protocol documentation. English (`docs/`) is the canonical source of truth and fallback language for all documentation.

---

## Directory Layout

The directory structure within `docs/i18n/<locale>/` mirrors the relative paths of the canonical English documentation:

```text
docs/
├── guides/
│   ├── connecting-your-wallet.md
│   └── ...
└── i18n/
    ├── README.md                          # This specification and guide
    └── es/                                # Target locale directory (e.g., Spanish)
        └── guides/
            └── connecting-your-wallet.md  # Translated guide
```

### Supported Locale Codes

Locale directory names use standard BCP 47 language tags:
- `es`: Spanish
- `fr`: French
- `pt-BR`: Brazilian Portuguese
- `zh`: Chinese (Simplified)

The frontend web application currently supports English (`en-US`), which serves as the fallback. Spanish (`es`) is the initial locale for documentation localization.

---

## What Must NOT Be Translated

To maintain technical precision and prevent broken commands or invalid contract interactions, the following elements must **never** be translated:

1. **Code Blocks and Scripts**: Rust code, TypeScript/JavaScript code, shell commands, SQL queries, and JSON payloads.
2. **Technical Identifiers**:
   - Contract entrypoints (e.g., `create_proposal`, `approve`, `execute`, `migrate_to_rbac`).
   - Types and structs (e.g., `Proposal`, `Delegation`, `Role`, `Transfer`).
   - Contract error names (e.g., `ContractError::MissingRole`, `Unauthorized`).
   - Event names (e.g., `ProposalCreatedEvent`, `RoleGrantedEvent`).
   - Storage keys and symbols (e.g., `OWNERS`, `THRESH`, `DELEG`).
3. **File Paths and Directory Names**: e.g., `contracts/accord/src/lib.rs`, `frontend/src/...`.
4. **Tool Names and Commands**: `cargo test`, `stellar contract build`, `freighter`, `friendbot`.
5. **Standard Protocol Terms**: XLM, USDC, EURC, Stroop, Soroban, Horizon.

---

## Links and Headings in Translations

When translating documents, headings change language, which alters the automatically generated anchor slugs (for example, `## Step 1` generates `#step-1`, while `## Paso 1` generates `#paso-1`).

To prevent broken cross-references:
1. **Prefer Document-Level Links**: Link to the target document (e.g., `[Roles & Permissions](../../guides/roles-and-permissions.md)`) rather than deep section anchors.
2. **Cross-Document Anchors**: If linking to a specific section of an untranslated document, link to the canonical English document's anchor.
3. **Explicit HTML Anchors**: When a translated document must support incoming links from other localized pages, place an explicit HTML anchor before the heading: `<a id="step-1"></a>`.

---

## Document Header Block (Front Matter)

Every translated document must begin with a YAML front matter header:

```yaml
---
source_file: docs/guides/connecting-your-wallet.md
source_commit: a22bc7ba98044b716193199db3b62f0124b83b4a
locale: es
status: draft
translators:
  - Accord Documentation Team (machine-assisted)
reviewers: []
notes: Initial draft translation. Machine-assisted; pending native speaker review.
---
```

### Status Values

| Status | Meaning |
|---|---|
| `draft` | Translation has been created (often machine-assisted) but has not yet been reviewed and validated by a fluent or native speaker. |
| `reviewed` | Translation has been verified for accuracy, natural phrasing, and technical fidelity by a fluent speaker. |
| `stale` | The canonical English source file has been modified in git since `source_commit`. |

---

## Contribution and Review Process

### 1. Opening a Translation PR
1. Create a branch from `main`: `git checkout -b docs/i18n-<locale>-<guide-name>`.
2. Mirror the relative path of the source file inside `docs/i18n/<locale>/`.
3. Add the YAML header block with `source_file`, the current git commit SHA of the English file (`source_commit`), `locale`, and your name or GitHub handle in `translators`.
4. Run the staleness check script locally: `node scripts/check-translation-staleness.js`.
5. Open a pull request titled: `docs(i18n): translate <guide> into <locale>`.

### 2. Review Requirements
Each translation pull request requires two approvals:
1. **Language Review**: At least one reviewer who is fluent in the target language to check for technical accuracy, natural tone, and correct terminology.
2. **Structure Review**: At least one repository maintainer to verify front matter completeness, file layout, and link integrity.

### 3. When No Fluent Reviewer Is Available
If a pull request is submitted for a language where no current maintainer or reviewer is fluent:
- The PR is marked with the label `needs-native-review`.
- The document is accepted into the repository with `status: draft`.
- The maintainers perform structure, front matter, and code block validation.
- A call for native-speaker review is posted on the issue tracker.

### 4. Contributor Credit
Translators and reviewers are acknowledged in:
- The `translators` and `reviewers` fields in the document header.
- The repository `.all-contributorsrc` file under the `translation` or `doc` categories.

---

## Checking Translation Staleness

To identify translations whose source English documents have changed since translation, run:

```bash
node scripts/check-translation-staleness.js
```

The script inspects all translated files under `docs/i18n/`, reads their `source_file` and `source_commit`, and compares them with git history to flag any stale or missing translations.
