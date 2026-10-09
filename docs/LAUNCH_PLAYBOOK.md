# Graft launch playbook

> Working launch kit for maintainers. Snapshot: October 9, 2026. Review platform support and release version before each public post.

## Positioning

**Brand:** Graft (the repository is named GraftCode).

**Core promise:** Your code. Your models. Your rules.

**One-liner:** Graft is an open-source desktop coding agent that works in your project, runs checks, and lets you choose the models and permissions.

**What makes it interesting:** Bring your own provider keys or run local models, inspect changes and rewind, connect tools through MCP, and optionally isolate commands in Docker or Podman. Don't position the product as a replacement for every coding assistant; demonstrate where the control and workflow are useful.

**Primary early-adopter audience:** Developers who want a local desktop coding agent with control over their model/provider, tool integrations, and code changes. Secondary audiences: local-model experimenters and makers using Blender, Unity or Roblox Studio.

**Proof to demonstrate, not just assert:** One real issue fixed in an existing project, with the before/after diff and actual test command output. Show a permission prompt and the rewind mechanism. Record actual local-model usage separately if claiming local-model functionality in a post.

## Launch gates: fix or disclose before promoting widely

1. **Installation trust:** The Windows installer is currently unsigned. Show the exact official download source, version and integrity/checksum verification instructions; prioritize signing and an independent security review where feasible. Do not bury SmartScreen warnings in fine print.
2. **Platform honesty:** Windows and Linux have ready-made downloads. macOS currently requires a source build; don't promote it as a one-click macOS download.
3. **First run:** Test the download-to-first-working-task path on clean machines. Explicitly explain that users supply an API key or configure a compatible local model; commercial providers may charge usage fees.
4. **Demonstrable results:** Make a 60–90 second, uncut-or-clearly-edited screen recording of a real repository task. Display the initial failing check, Graft's action, passing verification, and the final diff.
5. **Trust & support:** Publish tested platforms, known limitations, data/privacy boundaries, a security contact/reporting process, and how to report installation bugs.
6. **Contribution path:** Add CONTRIBUTING.md and issue templates; label a few genuinely approachable tasks once maintainers have verified them.

## One 70-second demo storyboard

- **0–8 sec — Hook:** "An open-source coding agent for your own models, with visible diffs and checks." Open the actual app.
- **8–25 sec — Problem:** Show a small failing test in a sample repository and ask Graft to fix it.
- **25–43 sec — Evidence:** Show files changed, the exact checks run, and the passing output.
- **43–57 sec — Control:** Open the changes/diff panel and show a permission choice or checkpoint/rewind.
- **57–70 sec — CTA:** Show provider selection, say that local models and BYOK are supported, then display the GitHub URL and the release downloads.

Record actual software behavior. Avoid fabricated test passes, edited logs, or benchmarking claims that lack reproducible results. Publish a short subtitled version and a longer technical walkthrough.

## Reusable launch copy

### Product Hunt

**Name:** Graft

**Tagline (under 60 characters):** Open-source coding agent for your own AI models

**Description (under 260 characters):**
Graft is a desktop AI coding agent that works in your repo, edits files, runs checks and shows diffs. Use your own provider keys or local models, connect MCP tools, and choose how much autonomy to grant. Open source under MIT.

**Suggested maker-comment outline:** Explain in your own words why you built Graft, who you built it for, show a real use case, acknowledge unsigned Windows installers and current macOS source-build status, and ask for concrete product and installation feedback. Product Hunt encourages authentic maker participation.

**Launch assets:** 1 square icon, 4–6 product screenshots, a short real demo video, versioned release links, and a first comment written by the maker. Give users a way to report bugs.

### Hacker News: Show HN

**Possible title:** Show HN: Graft – an open-source desktop coding agent with local model support

**Your own first-comment talking points:** Briefly describe the architectural decisions, why desktop/BYOK, what you learned building the agent and sandbox, trade-offs or limits, and exactly how readers can try a release or build from source. Invite technical criticism.

**Important:** Write the actual submission in your own words. HN guidelines discourage generated content and overt marketing; the Show HN program is currently subject to additional eligibility restrictions. Never ask friends to upvote or comment.

### Short launch post (X / LinkedIn / DEV introduction)

I built Graft, an open-source desktop AI coding agent.

It can work in a codebase, edit files, run checks and show what changed. Bring your own model provider or connect a local model; choose permissions and integrate tools through MCP.

Windows and Linux downloads are available, with macOS currently build-from-source. It's MIT licensed.

I would especially value feedback on installation, trust and real-world coding tasks:
https://github.com/itzdexy/GraftCode

### Reddit: technical discussion first

For r/opensource or a relevant developer community, post a genuine demo and technical explanation, not the same link blast across multiple forums. Declare clearly that you are the maintainer. If discussing local models in r/LocalLLaMA, lead with measured local-model compatibility and a reproducible configuration, comply with self-promotion limits, and contribute normally to the community first.

## Distribution plan: first 30 days

### Week 1 — Conversion before traffic

- Test installation and first task on Windows and Linux; write down points of friction.
- Create a real demo video and pin a short clip near the top of the README or a simple landing page.
- Clarify platform status, unsigned installer and BYOK/provider-cost expectations.
- Recruit five relevant developers to try Graft independently. Record their time-to-first-task and where they abandon onboarding.

### Week 2 — Technical proof

- Publish a transparent technical write-up about how permission modes, checkpoints, verification or MCP integration work in Graft, with code links and a replayable example.
- Share one narrow demo with a community where it genuinely solves a problem, following local rules.
- Fix the top two installation/usability issues surfaced by real testers.

### Week 3 — Public launch

- Submit to Product Hunt with a concise page and original video after establishing the maker account and checking the launch guidelines.
- Consider Show HN only once eligible, with the original source and a personally written technical explanation.
- Share the release with a few interested developers individually, asking for feedback, not stars or votes. Respond to discussion and bugs quickly.

### Week 4 — Retention and open-source flywheel

- Write an honest follow-up: what testers did, what failed, and what shipped after feedback.
- Publish a contributor guide and triaged entry-level issues; review incoming patches promptly.
- Turn a real troubleshooting session into documentation or a demo. Don't announce an unverified success metric.

## Measurement (use truthful counts)

| Funnel stage | Signal | Where / caveat |
| --- | --- | --- |
| Discovery | Referral clicks and GitHub visitors | GitHub traffic insights are limited in historical scope; optionally use privacy-respecting tagged links from your own site |
| Interest | Visits to releases and docs | Separately track meaningful actions from star counts |
| Activation | Successful first coding task | Opt-in user feedback or privacy-respecting analytics only; no sensitive code or keys |
| Quality | Failed installs and bug reports | GitHub issues and structured tester feedback |
| Retention | Users who return for a second task | Ask consenting testers; downloads do not equal active users |
| Community | External contributions and helpful discussion | Count substantive PRs and issues, not artificial engagement |

**Starter targets, not forecasts:** 5 independent testers in Week 1; 15–25 in the first month; at least 5 written, actionable pieces of feedback; and at least 3 independently reproducible use cases. Adjust after learning the actual conversion rate.

**Avoid vanity-number mistakes:** GitHub release asset downloads aren't unique installs. Metadata downloads (such as latest.yml or .blockmap) may be triggered by update checks. Stars show attention, not retained users. Do not buy stars, fake testimonials or coordinate votes.

## Platform and community rules to re-check before posting

- Product Hunt launch guide: https://help.producthunt.com/en/articles/17350772-launch-guide
- HN Show HN rules: https://news.ycombinator.com/showhn.html
- HN submission guidelines: https://news.ycombinator.com/newsguidelines.html
- HN temporary Show HN restriction notice: https://news.ycombinator.com/showlim
- Reddit community rules must be read at time of posting; r/LocalLLaMA has actively enforced a self-promotion limit.

## Next assets to build

- 60–90-second demo MP4 with captions.
- 15–30-second vertical demo clip showing the actual test/diff.
- Versioned release checksums and platform verification instructions.
- Human-authored build story and FAQ on how local models and provider keys work.
- Lightweight web landing page pointing to official releases, docs and the source.
