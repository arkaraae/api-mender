# API Mender design QA

## Reference and result

The four supplied Folk screenshots were used as visual references for spacing, typography, pill controls, a white/blue split sign-in layout, and a product-board preview. API Mender uses its own name, copy, colors, and product content. The preview is marked illustrative; live account data remains in the signed-in workspace.

## Checks

- Desktop landing: inspected at 1207 px browser width. Header, large centered hero, two calls to action, and board preview render without clipping the page.
- Desktop sign-in: inspected at 1207 px browser width. White form pane and pale blue preview pane render; account tabs and email entry are accessible in the DOM.
- Mobile landing and sign-in: inspected at 390 px width. No document-level horizontal overflow. The board preview clips intentionally within its frame. Corrected a missing word boundary in the mobile hero.
- Email entry: clicking **Continue with email** exposes labeled email and password fields and the account action. No credentials were submitted during visual QA.
- Demo: `/demo` still renders the existing simulated dashboard and identifies simulated data.
- TypeScript, seven automated tests, and a production build pass.

## Remaining operational check

The initial test account is now confirmed in Supabase, and its API Mender workspace exists. The exact local redirect URL is configured. Earlier confirmation links that return to the landing page now forward their token fragment to `/live` for session processing. Custom SMTP is still needed before relying on delivery to users outside the Supabase project team.

final result: passed
