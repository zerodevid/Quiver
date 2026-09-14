# Quiver Learn: implementation brief (v2)

## Goal
Build `#learn`, a bilingual (ID/EN) concentrated-liquidity course inside Quiver. It
should read like product documentation, not a marketing page. A user who finishes it
can read every number on a Quiver position and explain what their range will hold
at any price.

## Audience
Quiver operators, from a first-time LP to someone running copy-LP with manual
takeovers. Assume they know wallets and swaps. Do not assume they know ticks, IL,
or how inventory changes.

## Information architecture
- One page with three views: **Chapters**, **Lab**, **Glossary**. Each view and
  each chapter has a deep link (`#learn/<chapter>`, `#learn/lab`, `#learn/glossary`)
  that updates without remounting the page, so lab inputs survive view changes.
- Chapters are grouped into four modules: Basics → Intermediate → Advanced →
  Quiver practice. Show progress, a “continue” link, and prev/next navigation.
- Every chapter includes: module and reading time, 3 key points, numbered sections,
  an optional lab preset, one understanding check with an explanation, and
  Uniswap references.
- Progress is local to the browser (`localStorage`). A chapter counts as complete
  after a correct answer or an explicit “mark as done”. Navigating away does not
  mark it complete.

## Content requirements
- State price as quote per 1 base. Call out WETH-quoted pools as not USD.
- Cover inventory below, inside, and above the range. Also cover fees (including
  that no new fees accrue out of range), PnL vs IL vs BEP, ticks and rounding,
  range orders, fee modelling, compounding and rebalancing costs, hooks, token and
  exit risk, copy latency, stop-loss limits, and a decision journal.
- Tie explanations to real Quiver fields: range bar, entry %, BEP line, Last synced,
  and target PnL.
- Never imply that a lower bound is a stop-loss, that range orders can't reverse,
  that fees accrue while inactive, that a fee tier is a return, or that LP income is
  guaranteed. Examples are hypotheses, not recommendations.

## Lab requirements
- Model: TOKEN/USDG, entry 100, capital 100 USDG, quote assumed stable. The lab
  sends no transactions.
- Inputs are lower bound, upper bound, scenario price, assumed fees, and assumed
  gas/slippage. Include presets for sideways, rise, staged sell, staged buy, dump,
  and volatile/wide, each with a one-line thesis.
- Outputs are position value, PnL (% of capital), LP vs hold (IL), BEP, and an
  LP-vs-hold chart with range band, a real legend, and a text alternative. Also
  show inventory at the scenario price with range status. Include a scenario table
  and the formulas.
- Handle edge states explicitly. These include BEP unreachable, capital already
  covered, BEP off the axis, and single-sided entry.
- Reuse the dashboard's `breakEven` so the lab and positions agree.

## Quality bar
- Use HeroUI and theme tokens only. It must look right in light/dark, ID/EN, and at
  400px with no horizontal scroll. Add proper labels/roles for sliders, radio
  groups, and the quiz.
- Readable code that matches the repo: multi-line JSX, Indonesian comments,
  content in `learn/content.js` and `learn/glossary.js`, lab in `learn/Lab.jsx`.

## Verification before deploy
1. `node --test web/src/learn/math.test.js web/src/breakeven.test.js`
2. `vite build` succeeds.
3. Playwright: deep links, quiz feedback and progress persistence, lab preset from a
   chapter, lab state preserved across views, glossary search/empty state, no page
   errors, screenshots at 1440px and 400px in both themes and languages.
4. Deploy to LP1 and LP2 only after checking `git status` for other sessions'
   uncommitted work, since `deploy.sh` ships the whole working tree.
