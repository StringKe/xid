# Anti-slop catalog

Lookup material for the frontend-design skill: why AI-default output happens, the full ban list with
the reason and source for each entry, the replacement practices, and the per-surface reference set.
Sources were collected in 2026-10 and favor 2025-2026 material. Quoted source text replaces em
dashes with `--` and arrows with `->`.

A hit on this list is not an automatic rework; scoring lives in `review-checklist.md`. Hosted Auth,
the account portal and Console already have a design system, so "change the font or the primary
color" is never the fix there; the target is literal values that bypass tokens and component-kit
skins used unchanged. The Site shares the same `--xid-*` values; this list targets its page
composition, content blocks and copy.

## 1. Why it happens

| Cause                      | What it means                                                                                                                                                                                                                                     | Source                                                                                                                                                                                             |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Distributional convergence | Without direction the model samples the safest, most common choices: Inter, purple gradient on white, minimal motion. Without constraints models fall back to "high-frequency patterns from the training data".                                   | https://claude.com/blog/improving-frontend-design-through-skills , https://developers.openai.com/blog/designing-delightful-frontends-with-gpt-5-4                                                  |
| Indigo as the corpus mode  | Adam Wathan apologized in 2025-08 for `bg-indigo-500` on every Tailwind UI button, the likely source of indigo AI interfaces. Generated sites feed back into the corpus.                                                                          | https://tannerhodges.com/blog/purple-buttons/ , https://github.com/febbhav/signs-of-ai-design                                                                                                      |
| Defaults nobody replaced   | shadcn hands over primitives and leaves CSS variables to the user; 88% of readable fonts in the 150 most-starred shadcn repos are Geist or Inter, 75% of primaries are neutral grey. Brand guides cover about 5% of the decisions a screen needs. | https://uxskill.laithjunaidy.com/blog/shadcn-ui-looks-generic.html , https://laithjunaidy.com/writing/taken-apart-shadcn-defaults , https://tasteprofile.io/blog/why-ai-generated-ui-looks-generic |
| Adjectives collapse        | "modern, clean, minimal, premium" land in the same region of the model and produce the same UI.                                                                                                                                                   | https://tasteprofile.io/blog/why-ai-generated-ui-looks-generic                                                                                                                                     |
| No structural stance       | Vague audience, no story in the order, no reason for the layout, would fit any other project unchanged. "The problem is not that AI makes bad work. It is that AI makes bad work look finished."                                                  | https://note.com/sakamototakuma/n/n0cf7bad2d9a8?hl=en , https://www.hugeinc.com/ideas/anyone-can-make                                                                                              |
| Self-review is blind       | Models praise their own output confidently even when it is plainly mediocre, so the generator cannot be its own reviewer.                                                                                                                         | https://www.anthropic.com/engineering/harness-design-long-running-apps                                                                                                                             |
| Bans leak                  | A generator that banned "not X but Y" still measured 2.3 AI-isms per 1000 words, almost all the banned one. A team that banned fabrication still shipped 70+ fake claims hardcoded in templates.                                                  | https://scriptgrain.com/reference/ai-isms-in-marketing-copy , https://wishdeal.com/factory/playbooks/seventy-fabrications/                                                                         |
| Lists age                  | Once purple was mocked, models moved to cream, italic serif and emerald.                                                                                                                                                                          | https://github.com/febbhav/signs-of-ai-design                                                                                                                                                      |

Reconciling principle: "The problem is that nobody chose any of it." (https://oim3690.github.io/guides/ai-slop/); "make it a decision, not a default" (https://github.com/febbhav/signs-of-ai-design/blob/main/design-rules.md). OpenAI's 2025 GPT-5 guide recommended Inter and Geist while its 2026 GPT-5.4 article says to avoid default stacks, and Resend's brand documents gradient text and blur as decisions -- the same treatment is a default in one place and a choice in another (https://developers.openai.com/cookbook/examples/gpt-5/gpt-5_prompting_guide , https://resend.com/design). Existing design systems win: "preserve the established patterns, structure, and visual language" (https://developers.openai.com/api/docs/guides/frontend-prompt).

## 2. Using the shipped Geist and steel blue without the default look

XID's fonts and accent are not on the ban list. What makes them read as chosen:

- Headings are not enlarged body text: `weight.display` 560 with `--xid-tracking-display` /
  `-heading` / `-title`, sizes only from `scale.stylex.ts`.
  https://raw.githubusercontent.com/anthropics/claude-code/main/plugins/frontend-design/skills/frontend-design/SKILL.md
- Geist Mono only for content that is monospaced by nature (client ID, `kid`, JWT, code, command,
  key prefix). "Never use monospace for titles or body copy". https://resend.com/design
- `tabular-nums` for numeric columns, times and counts. https://vercel.com/design/guidelines
- The accent communicates action and state; the page body stays neutral. "Accent colors communicate
  state, not style"; "one clear accent for action or state". A page washed in blue-grey falls into
  the dark blue/slate monochrome OpenAI names. https://resend.com/design ,
  https://developers.openai.com/api/docs/guides/frontend-prompt
- `#161616` text and the `#111111` dark sidebar are shipped neutral near-blacks. Anthropic lists
  "tinted near-black standing in for black" as a template widget but also says "All traits are
  legitimate for some briefs"; do not switch to pure black to dodge the list.
  https://github.com/pythoughts-labs/designer-skill/blob/main/skills/designer-skill/reference/avoid-ai-slop.md
- Distinction comes from content and structure: real protocol objects, real screenshots, accurate
  copy, complete states.

## 3. Ban list

### 3.1 Visual

| Pattern                                                                                                            | Why it reads as AI                                                                                                           | Source                                                                                                                                                            |
| ------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Indigo/purple primary, purple-to-blue gradient background, `background-clip: text` gradient headline               | Mode of the Tailwind examples in the corpus; a gradient makes an unsolved hierarchy look finished and carries no information | https://tannerhodges.com/blog/purple-buttons/ , https://medium.com/@ai.in.motion.blog/the-purple-problem-why-ai-cant-stop-generating-purple-websites-4381fb066883 |
| Cream background (near `#F4F1EA`) + high-contrast serif headline + terracotta accent (near `#D97757`)              | Second-generation default after purple; terracotta is Claude's own interaction accent                                        | https://raw.githubusercontent.com/anthropics/claude-code/main/plugins/frontend-design/skills/frontend-design/SKILL.md                                             |
| Near-black + a single acid-green or vermilion accent                                                               | The second cluster named in the same skill                                                                                   | same                                                                                                                                                              |
| Emerald or cream as the escape from purple; near-black together with eyebrow, middle dot and `->` widgets as a set | "Do not fall back to emerald or cream just because purple is off the table"                                                  | same, https://github.com/febbhav/signs-of-ai-design/blob/main/design-rules.md                                                                                     |
| Whole page in one hue (all purple, beige/sand, dark blue/slate, or brown/orange)                                   | OpenAI asks to scan CSS colors before finishing and change any page that reads as one of these                               | https://developers.openai.com/api/docs/guides/frontend-prompt                                                                                                     |
| Four equal pastel colors, none dominant                                                                            | No primary/secondary decision                                                                                                | https://github.com/febbhav/signs-of-ai-design/blob/main/design-rules.md                                                                                           |
| Type carries no hierarchy: headline is enlarged body, weight, tracking and scale are framework defaults            | The issue is the missing decision, not the font                                                                              | https://uxskill.laithjunaidy.com/blog/shadcn-ui-looks-generic.html , https://platform.claude.com/cookbook/coding-prompting-for-frontend-aesthetics                |
| Space Grotesk, Instrument Serif, Fraunces, Syne, Plus Jakarta Sans as the escape from Inter                        | "You still tend to converge on common choices (Space Grotesk, for example)"; copying a recommended list is a new default     | https://platform.claude.com/cookbook/coding-prompting-for-frontend-aesthetics , https://github.com/AdrianKrebs/ai-design-checker/blob/main/README.md              |
| One word in a headline switched to italic serif, bold or color                                                     | The cheapest drama                                                                                                           | https://github.com/AdrianKrebs/ai-design-checker                                                                                                                  |
| Arbitrary sizes (36/24/18/16) with no ratio                                                                        | Template hierarchy; use one consistent scale                                                                                 | https://github.com/hungv47/meta-skills/blob/main/skills/marketing/create-brand/references/ai-slop-detection.md                                                    |
| Mid-grey body text on dark, contrast barely passing                                                                | Template colors never checked for legibility                                                                                 | https://www.developersdigest.tech/blog/ai-design-slop-and-how-to-spot-it                                                                                          |
| Literal hex / `oklch()` or arbitrary classes (`p-[13px]`, `text-[#hex]`) in a component                            | Models invent arbitrary values; in XID they also break dark mode and tenant brand override                                   | https://www.braingrid.ai/blog/design-system-optimized-for-ai-coding                                                                                               |

### 3.2 Layout

| Pattern                                                                                                                             | Why it reads as AI                                                            | Source                                                                                                                                             |
| ----------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| Centered hero formula: pill badge + oversized full-sentence headline + one-line subhead + solid and ghost buttons + glow orb behind | The shadcn landing and Next.js starter shape; the most cited tell             | https://github.com/AgentEnder/design-drafts/blob/main/docs/anti-patterns.md , https://github.com/AdrianKrebs/ai-design-checker/blob/main/README.md |
| Fixed order: hero, logo wall, three cards, testimonial carousel, stat bar, three-tier pricing, FAQ accordion, footer CTA            | Organized by component inventory, not narrative                               | https://labtwelve.dev/blog/why-ai-generated-websites-look-the-same , https://github.com/febbhav/signs-of-ai-design                                 |
| Stat bar ("10K+ users", "99.9% uptime", ratings)                                                                                    | "Used everywhere, trusted nowhere"; most products have not earned the numbers | https://subclaude.com/slop/ , https://www.newwebsite.ai/blog/10-signs-a-website-was-designed-by-ai                                                 |
| First screen of big number + small label + supporting stat + gradient garnish                                                       | Named as the default treatment                                                | https://raw.githubusercontent.com/anthropics/claude-code/main/plugins/frontend-design/skills/frontend-design/SKILL.md                              |
| 01/02/03 numbering or a 1-2-3 step rail on content that is not a sequence                                                           | Structure that encodes nothing                                                | same, https://github.com/AdrianKrebs/ai-design-checker                                                                                             |
| Bento grid, especially with filler cells                                                                                            | Component scaffolding instead of narrative; not an escape from three cards    | https://www.viton13.com/research/18-ai-websites-look-the-same                                                                                      |
| Newspaper layout: hairline columns, zero radius, dense multi-column                                                                 | Third second-generation cluster                                               | https://raw.githubusercontent.com/anthropics/claude-code/main/plugins/frontend-design/skills/frontend-design/SKILL.md                              |
| Uniform spacing everywhere, no tight-within / loose-between rhythm                                                                  | Rhythm was never designed                                                     | https://github.com/pbakaus/impeccable/blob/main/.agents/skills/impeccable/scripts/detector/registry/antipatterns.mjs                               |
| Every block a centered vertical stack, nothing asymmetric or spanning                                                               | Default composition                                                           | --                                                                                                                                                 |
| Admin home: sidebar + four KPI cards with red/green deltas + full-width line chart + zebra table at marketing spacing               | shadcn/Tailwind UI default output, "looks like a prototype, not a tool"       | https://uxskill.laithjunaidy.com/blog/ai-dashboard-design-generic.html                                                                             |

### 3.3 Components

| Pattern                                                                                                             | Why it reads as AI                                                                                                         | Source                                                                                                                |
| ------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| Three equal cards, each "rounded icon tile + bold title + two grey lines"                                           | "The universal AI feature-card template; every generator outputs this exact shape"                                         | https://github.com/pythoughts-labs/designer-skill/blob/main/skills/designer-skill/reference/avoid-ai-slop.md          |
| Icon on a pale tile of its own hue (`text-blue-500` on `bg-blue-500/10`)                                            | Variant of the same template                                                                                               | https://oim3690.github.io/guides/ai-slop/                                                                             |
| One radius and one `rgba(0,0,0,.1)` soft shadow on everything                                                       | Radius and shadow do not follow hierarchy                                                                                  | https://prg.sh/ramblings/Why-Your-AI-Keeps-Building-the-Same-Purple-Gradient-Website                                  |
| Nested radii equal inside and out                                                                                   | Inner radius = outer radius - padding                                                                                      | https://github.com/borghei/Claude-Skills/blob/HEAD/engineering/design-auditor/references/ai_slop_patterns.md          |
| Hairline border and a large shadow on the same element                                                              | Boundary and elevation need only one signal                                                                                | https://github.com/pbakaus/impeccable/blob/main/.agents/skills/impeccable/scripts/detector/registry/antipatterns.mjs  |
| Cards inside cards; "cards" whose border and shadow can be removed without loss                                     | "If removing a border, shadow, background, or radius does not hurt interaction or understanding, it should not be a card." | https://developers.openai.com/blog/designing-delightful-frontends-with-gpt-5-4                                        |
| 3-4px colored left bar on ordinary cards or rows                                                                    | A semantic callout treatment used as decoration; among the most recognizable tells                                         | https://github.com/febbhav/signs-of-ai-design/blob/main/design-rules.md                                               |
| Tracked ALL CAPS eyebrow above every heading                                                                        | Appears in 55-95% of generations regardless of topic                                                                       | https://github.com/pythoughts-labs/designer-skill/blob/main/skills/designer-skill/reference/avoid-ai-slop.md          |
| Middle-dot meta strings; `->` suffix on links and buttons; "WORD -- fragment" labels; mono for decorative labels    | Second-generation template widgets                                                                                         | https://raw.githubusercontent.com/anthropics/claude-code/main/plugins/frontend-design/skills/frontend-design/SKILL.md |
| "New" / "Beta" pills outside the hero on section titles, cards and nav                                              | "Startup template cargo-cult"                                                                                              | https://labtwelve.dev/blog/why-ai-generated-websites-look-the-same                                                    |
| Three-tier pricing with a highlighted middle, "Most popular" gradient pill, five-star rows                          | Template components; XID also has no plans (iron rule 9)                                                                   | https://labtwelve.dev/blog/why-ai-generated-websites-look-the-same                                                    |
| A row of status pills each in its own bright color ("Skittles Status"), micro text                                  | Too many colors to mean anything; keep status to one or two hue families                                                   | https://github.com/hankimis/ai-design-tells/blob/main/harness/AI-DESIGN-TELLS.md                                      |
| Decorative icons that do not aid scanning; heavy borders on every region                                            | Named as avoid for app UI                                                                                                  | https://developers.openai.com/blog/designing-delightful-frontends-with-gpt-5-4                                        |
| Component-kit skin used unchanged (zinc/slate, default `--radius`, documentation-example Card / DataTable / Dialog) | "The components are excellent. The defaults are the trap."                                                                 | https://freedesignmd.com/blog/shadcn-looks-generic                                                                    |

### 3.4 Motion

| Pattern                                                                                                      | Why it reads as AI                                                                         | Source                                                                                                                |
| ------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------- |
| Fade-up on every section while scrolling, hover animation on every card                                      | "the generic default and read as AI-generated"                                             | https://raw.githubusercontent.com/anthropics/claude-code/main/plugins/frontend-design/skills/frontend-design/SKILL.md |
| Animation on high-frequency actions (shortcuts, command menu, row hover, tab switch)                         | Hundreds of uses a day make the UI feel slow; Raycast's command menu has no open animation | https://github.com/emilkowalski/skills/blob/main/skills/animate/SKILL.md                                              |
| Bounce/elastic easing, `ease-in` entrances, `scale(0)` entrances, `transition: all`, UI animation over 300ms | Default parameters never tuned                                                             | https://emilkowal.ski/ui/7-practical-animation-tips , https://vercel.com/design/guidelines                            |
| Looping gradient headline, auto-scrolling marquee, decorative blinking cursor, pulsing status dot            | Fake liveliness with no state change                                                       | https://tenex.studio/en/blog/ai-slop-ui-8-signes/                                                                     |
| Entrance choreography replayed on every refresh                                                              | Choreography plays on first visit only                                                     | https://rauno.me/craft/novelty                                                                                        |
| Ignoring `prefers-reduced-motion`                                                                            | Required by the guidelines                                                                 | https://vercel.com/design/guidelines                                                                                  |

### 3.5 Imagery and icons

| Pattern                                                                                                                 | Why it reads as AI                                                     | Source                                                                                                       |
| ----------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| Div-built fake dashboard, fake terminal, traffic-light browser chrome, tilted with reflection                           | "the #1 LLM-design Tell"                                               | https://github.com/pythoughts-labs/designer-skill/blob/main/skills/designer-skill/reference/avoid-ai-slop.md |
| Glassmorphism (`backdrop-blur` + 10% white hairline), neon glow, zero-offset colored `box-shadow`, gradient orbs, bokeh | Cheapest "premium"; OpenAI says not to add orbs or bokeh as decoration | https://developers.openai.com/api/docs/guides/frontend-prompt                                                |
| Emoji as icons, bullets or badges                                                                                       | The cheapest icon substitute in training snippets                      | https://labtwelve.dev/blog/why-ai-generated-websites-look-the-same                                           |
| One icon forced onto unrelated concepts (Sparkles = AI, Zap = fast, Shield = secure)                                    | Icons with no meaning                                                  | https://github.com/febbhav/signs-of-ai-design/blob/main/design-rules.md                                      |
| Floating 3D figures, low-poly art, abstract "connection / intelligence" shapes                                          | Generic stock of the training data                                     | https://www.hugeinc.com/ideas/anyone-can-make                                                                |
| Generated images: warm yellow cast, waxy skin, garbled background text                                                  | Inherent flaws of generated images                                     | https://github.com/febbhav/signs-of-ai-design/blob/main/design-rules.md                                      |
| Fake handmade: jitter lines on a generic mark, rough fonts for a brand with no rough trait                              | "This is the same generic output wearing a costume"                    | https://www.serifandgold.com/journal/the-handmade-premium                                                    |
| Not one real product screenshot or real object on the page                                                              | Nothing to show means the page is not done                             | https://tenex.studio/en/blog/ai-slop-ui-8-signes/                                                            |

### 3.6 Copy

| Pattern                                                                                                                     | Why it reads as AI                                                           | Source                                                                                                                                                                         |
| --------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Hollow cluster: seamless, empower, unlock, elevate, robust, leverage, streamline, effortlessly, next-generation, AI-powered | True of any product; "Effortlessly" appears in about 60% of AI hero subheads | https://sailop.com/blog/banned-phrases-40-words-mark-copy-ai-generated , https://slobodandekanic.com/ai-cliche-list-for-copywriters/                                           |
| Chinese filler: 赋能, 助力, 打造, 抓手, 闭环, 一站式, 全方位, 多维度                                                        | Fits any topic                                                               | https://github.com/LifelongLazyLearner/qu-ai-wei/blob/v0.6.5/WARP.md                                                                                                           |
| Padded triplets, "not X but Y", "not only... but also"                                                                      | Listed as LLM tells; survive prompt bans                                     | https://en.wikipedia.org/wiki/Wikipedia:Signs_of_AI_writing                                                                                                                    |
| Em dashes joining clauses                                                                                                   | Far above the human baseline in some models                                  | https://msukhareva.substack.com/p/the-mystery-of-emdashes-part-two                                                                                                             |
| "[Verb] your [noun] with [adjective] [noun]" headlines naming only the category                                             | All ten AI-built landing pages used it; none had a number or named a user    | https://roast.page/blog/ai-built-10-landing-pages                                                                                                                              |
| Fabricated social proof: fake testimonials, "Trusted by 10,000+ teams", unlicensed logo walls, unaudited compliance badges  | Actively destroys trust; most dangerous when hardcoded in a template         | https://roast.page/blog/trust-gap , https://wishdeal.com/factory/playbooks/seventy-fabrications/                                                                               |
| Claims above the shipped support level                                                                                      | Fabrication; in XID it violates `docs/protocols/source-map.md`               | `docs/protocols/source-map.md`, `docs/protocols/gap-audit.md`                                                                                                                  |
| Title Case headings and buttons                                                                                             | Polaris, Atlassian and GOV.UK require sentence case                          | https://atlassian.design/foundations/content/language-and-grammar , https://github.com/Shopify/polaris/blob/main/polaris.shopify.com/content/content/grammar-and-mechanics.mdx |
| Filler openers and closers: "Welcome back! We're thrilled...", "In today's fast-paced world"                                | "blah-blah text"                                                             | https://www.nngroup.com/articles/blah-blah-text-keep-cut-or-kill/                                                                                                              |
| simply, easy, just, quickly, exclamation marks                                                                              | Banned by the Google and Kubernetes style guides                             | https://developers.google.com/style/word-list , https://kubernetes.io/docs/contribute/style/style-guide/                                                                       |
| Headline, subhead and button saying the same thing                                                                          | Redundant UX copy                                                            | https://www.linkedin.com/posts/paulbakaus_ai-slop-design-tells-design-anti-patterns-activity-7416272383017164800-10DR                                                          |
| Console sentences that could be a homepage hero; UI text describing the app's features                                      | Admin copy states location, state and action, not promises                   | https://developers.openai.com/api/docs/guides/frontend-prompt                                                                                                                  |
| Leftover placeholders: John Doe, Acme, Lorem Ipsum, `#` links, "[Your Company]", too-tidy fake numbers                      | Template residue                                                             | https://github.com/pythoughts-labs/designer-skill/blob/main/skills/designer-skill/reference/avoid-ai-slop.md                                                                   |
| Emotional empty and error states: "Oops!", "Nothing here yet! Let's get started.", apologies, please                        | No cause and no way out                                                      | https://atlassian.design/content/designing-messages/writing-error-messages                                                                                                     |

## 4. Replacement practices

General:

1. Constraints before generation; the two-pass plan (named colors or tokens, type roles, one-line
   layout plus ASCII wireframe, one signature element), then audit the plan.
   https://raw.githubusercontent.com/anthropics/claude-code/main/plugins/frontend-design/skills/frontend-design/SKILL.md
2. Constraints become tokens, not adjectives: "Prompts are interpretation. Specs are contract."
   https://tasteprofile.io/blog/why-ai-generated-ui-looks-generic
3. "Spend your boldness in one place"; structural elements must carry information (same source as 1).
4. Hierarchy from size, weight, spacing and the neutral ramp; tiered radius and shadow; smaller radii
   read more formal. https://workos.com/docs/authkit/branding
5. Few color inputs, perceptually generated; accent for state, not style; state never by color alone.
   https://linear.app/now/how-we-redesigned-the-linear-ui , https://vercel.com/design/guidelines
6. Typography details: headline line height 1.0-1.25; body measure 45-75 characters;
   `text-wrap: balance` on headings, `pretty` on paragraphs. XID tracking comes from the
   `--xid-tracking-*` tokens. https://typographyhandbook.com/ , https://vercel.com/design/guidelines
7. Motion by frequency and purpose: no animation for actions used hundreds of times a day; ease-out
   entrances under 300ms; animate only `transform` and `opacity`; choreography on first visit only.
   XID product surfaces use the `packages/web-ui/src/motion/` springs.
   https://github.com/emilkowalski/skills/blob/main/skills/animate/SKILL.md , https://rauno.me/craft/novelty
8. Detail floor: optical alignment within 1px, visible `:focus-visible`, 44px touch targets, 16px
   mobile inputs, loading buttons keep their label, skeletons match final content, empty / sparse /
   dense / error states, short / medium / long content, destructive actions confirmed or undoable,
   the single-character ellipsis. https://github.com/vercel-labs/web-interface-guidelines/blob/main/AGENTS.md
9. Real content and real data lengths (diacritics, long URLs, long IDs) set widths and sizes.
   https://developers.openai.com/blog/designing-delightful-frontends-with-gpt-5-4
10. Copy: facts instead of adjectives; the user's words; one verb per action across the flow
    (button "Publish", toast "Published"); sentence case.
    https://github.com/anthropics/skills/blob/main/skills/frontend-design/SKILL.md
11. Subtract: remove decoration until the interface breaks, then restore that one thing; after
    several rounds check the new page still belongs to the same site. https://oim3690.github.io/guides/ai-slop/

Site:

- First-screen budget: brand, one headline, one supporting line, one CTA group, one dominant visual;
  no stat strip or secondary promotion. H1 names the product or literal category.
  https://developers.openai.com/blog/designing-delightful-frontends-with-gpt-5-4 ,
  https://developers.openai.com/api/docs/guides/frontend-prompt
- Prove before claiming: each claim followed by a real artifact; mock values must "look real, not
  schematic". https://kage.design/designs/resend-empty-state
- No cards by default: sections, columns, lists and media blocks, one job per section, ordered as a
  narrative. https://www.viton13.com/research/18-ai-websites-look-the-same
- Facts as selling points, e.g. "Passwords are hashed with Argon2id. PKCE accepts S256 only." and
  "MIT licensed. Self-hosting gets every feature, with no license check."
- Borrow from print references with a stated reason, but print has its own averages (ivory and
  hairlines are already second-generation). https://note.com/sakamototakuma/n/n0cf7bad2d9a8?hl=en

Hosted Auth:

- Fewer steps, lower information cost, less noise; Microsoft removed product logos and custom
  backgrounds from its 2025 sign-in redesign. https://microsoft.design/articles/reimagining-our-front-door/
- The brand belongs to the integrating tenant: AuthKit takes four color inputs and derives focus,
  hover and border. https://workos.com/docs/authkit/branding ,
  https://clerk.com/blog/introducing-mosaic-bring-your-brand-to-every-authentication-flow
- Credential errors are identical by design (iron rule 7); specificity goes only to the next step.
  "Try again in 15 minutes" only when the implementation returns a wait time without revealing the
  limit dimension. https://saglitz.com/design/auth-and-session-ux ,
  https://design.infor.com/patterns/interactions/sign-in/
- Title "Sign in", no welcome; errors without apology.
  https://ix.siemens.io/docs/guidelines/language/menu-functions-and-ui-labels/logging-in-and-out

Console:

- "avoid oversized hero sections, decorative card-heavy layouts, and marketing-style composition";
  default to "Linear-style restraint". https://developers.openai.com/api/docs/guides/frontend-prompt ,
  https://developers.openai.com/blog/designing-delightful-frontends-with-gpt-5-4
- Dim the navigation so the workspace leads, compact tabs, fewer and smaller icons, softer dividers.
  https://linear.app/now/behind-the-latest-design-refresh
- Every KPI maps to an action; a prioritized exception queue often beats four cards and a chart.
  https://recipes.mui.com/blog/ai-generated-admin-dashboard-ui
- Separate first-use, filtered and failed empty states; a zero-result table keeps its shape.
  https://supabase.com/design-system/docs/ui-patterns/empty-states

## 5. Site parts

The Site needs a few parts the product does not have. Each is composed from existing primitives and
`--xid-*` values; none introduces a new color, font or radius.

| Part             | Spec                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Header           | 56px, opaque `--xid-bg`, 1px bottom border, sticky; graphic XID logo at 20px; nav items 32px, current item `fg` + 500 without a fill; right side language, theme, "Sign in" (ghost) and the XID Cloud sign-up button (primary, 36px). Below 48rem the nav moves into a drawer.                                                                                                                                                                                         |
| Hero             | At >= 64rem two columns, text left (up to 680px) and product frame right; one column below. Headline `clamp(2.5rem, 1.6rem + 2.6vw, 3.5rem)`, line height 1.05, weight 560, `--xid-tracking-display`, `text-wrap: balance`. Lead 20px `muted-foreground`, max 36rem. Primary + secondary `lg` buttons. One 13px line under the actions may state the business model: XID Cloud is free today, any future charge is metered MAU only, self-hosting is the same product. |
| Section header   | Title on the clamped 28-40px step; a two-part title may set the first half in `muted-foreground` at the same size and weight. Lead 16px, max 40rem. Title left and lead right at >= 64rem. No 01/02 numbering, no mono eyebrow.                                                                                                                                                                                                                                        |
| Product frame    | Real demo-instance screenshot, light and dark images switched by `[data-theme]`; 1px `--xid-border`, `--xid-radius-lg`; optional 32px top bar with the real hostname in mono 12px only; `shadow-md` on the hero instance only. At most two stacked layers offset by `space.s8`. No tilt, 3D, gradient plate, glow, colored shadow, hand-drawn arrows, AI illustration or traffic-light dots. Narrow screens use a real narrow screenshot.                              |
| Capability row   | Grid `11rem minmax(0,1fr) auto` at >= 40rem: name (16px / 560), one or two sentences (14px `muted-foreground`, optional docs link), evidence badge. Hairline between rows.                                                                                                                                                                                                                                                                                             |
| Comparison table | Product table style, sticky first column, horizontal scroll on narrow screens. Cells hold a `check` icon in `fg`, a faint dash, or a `Badge`; no green ticks, red crosses or colored cells; the XID column header is `fg` + 500 without a fill. No prices. A 13px note cites `docs/protocols/source-map.md`.                                                                                                                                                           |
| Evidence badge   | `Badge` mapped from `docs/protocols/README.md`: L4 success "Production", L3 info "Verified end to end, local", L2 neutral "Integration-tested", L0-L1 neutral "Implemented", missing outline "Not yet". Always text; links to the `source-map.md` row.                                                                                                                                                                                                                 |
| Code with result | A titled code block (for example `authenticateRequest`) next to a key-value list of the decoded `at+jwt` claims including `tenant_id`; no connecting arrow; no `npm install` line.                                                                                                                                                                                                                                                                                     |
| Fact strip       | `MetricsBand` with repository-checkable facts only: MIT, 3 Workers, 8 locales, 1 codebase. No percentages, customer counts or latency.                                                                                                                                                                                                                                                                                                                                 |
| Closing band     | 1px top border, generous vertical space, one sentence title, primary + secondary (self-host guide) buttons. No gradient and no inverted dark block.                                                                                                                                                                                                                                                                                                                    |
| Footer           | 1px top border; logo, one positioning line, "MIT licensed"; three or four link columns with `sectionLabel` titles; language, theme and copyright on the last row.                                                                                                                                                                                                                                                                                                      |

## 6. References per surface

Borrow only the named point, never the whole look.

| Surface | Reference                        | Borrowed point                                                                                     | Source                                                                                                                  |
| ------- | -------------------------------- | -------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| Site    | Resend                           | A real code window or screenshot right after each claim; accent for state only                     | https://resend.com/design , https://kage.design/designs/resend-empty-state                                              |
| Site    | Linear website                   | The real product UI at the center of the first screen, no abstract hero art                        | https://www.linkedin.com/posts/benoit-design_linears-redesign-10xd-their-valuation-in-activity-7319027033202741248-ve_U |
| Site    | Vercel / Rauno                   | Entrance choreography on first visit only; detail rules written as checkable guidelines            | https://rauno.me/craft/novelty , https://vercel.com/design/guidelines                                                   |
| Hosted  | WorkOS AuthKit                   | Four color inputs with derived focus, hover and border; smaller radii read more formal             | https://workos.com/docs/authkit/branding                                                                                |
| Hosted  | Microsoft account sign-in (2025) | No product logo or custom background, fewer steps, passwordless first                              | https://microsoft.design/articles/reimagining-our-front-door/                                                           |
| Console | Linear 2026 refresh              | Dimmed sidebar, compact tabs, fewer and smaller icons, softer dividers                             | https://linear.app/now/behind-the-latest-design-refresh                                                                 |
| Console | Supabase design system           | Presentational and table empty states kept separate                                                | https://supabase.com/design-system/docs/ui-patterns/empty-states                                                        |
| Console | Raycast                          | No open/close animation on a command menu used hundreds of times a day                             | https://github.com/emilkowalski/skills/blob/main/skills/animate/SKILL.md                                                |
| Console | Stripe Dashboard                 | Contrast-driven color tokens; responsive work keeps table, filter and dialog patterns recognizable | https://mattstromawn.com/projects/stripe-dashboard/                                                                     |

Not references: an undirected Claude project-management landing page (Inter, purple gradient,
standard layout; https://claude.com/blog/improving-frontend-design-through-skills); dnaexplore.ai
(31 em dashes on one page, gradient headline, six identical cards;
https://tenex.studio/en/blog/ai-slop-ui-8-signes/); dark glass-gradient "Linear style" imitations
(https://blog.logrocket.com/ux-design/linear-design/).

## 7. Maintenance

The list ages. When a review finds a new unchosen default, add it here with a source and check
whether it is already widely recognized (https://github.com/febbhav/signs-of-ai-design). No designer
commentary specific to AI-default hosted sign-in pages was found; the Hosted entries derive from the
Microsoft, SaglitzDesign, WorkOS, Clerk and Auth0 sources above.
