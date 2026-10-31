# Changelog

Every release of the template, newest first. [release-please](https://github.com/googleapis/release-please)
writes each entry from the [Conventional Commits](https://www.conventionalcommits.org/) merged into
`main` (`feat:`, `fix:`, …) when its release pull request is merged: do not edit the entries by
hand. What `main` has that no release has yet is listed in that open release pull request.

## 0.1.0 (2026-10-31)


### Features

* **agents:** dogfood [#2](https://github.com/Crowley-VS/agentic-tanstack/issues/2) fixes (.env.local ports, npx check, URL state and read-filter guidance) ([#49](https://github.com/Crowley-VS/agentic-tanstack/issues/49)) ([35e8045](https://github.com/Crowley-VS/agentic-tanstack/commit/35e80451b213089ebd850ec4d13298ea4e419197))
* **agents:** M5h add-feature skill (schema to e2e, the regen command per generated file) ([#20](https://github.com/Crowley-VS/agentic-tanstack/issues/20)) ([d0dbd05](https://github.com/Crowley-VS/agentic-tanstack/commit/d0dbd055d103870190a914ef1018241ea46db080))
* **agents:** M7 dogfood fixes (bootstrap formatting, pnpm db:psql, skill guidance, local DB permissions) ([#39](https://github.com/Crowley-VS/agentic-tanstack/issues/39)) ([8c77f5a](https://github.com/Crowley-VS/agentic-tanstack/commit/8c77f5aaf4ef7d16b78ed46eb39a77aedcd7d3d8))
* **agents:** M7a task skills and an always-run skill reference check ([#31](https://github.com/Crowley-VS/agentic-tanstack/issues/31)) ([e436c62](https://github.com/Crowley-VS/agentic-tanstack/commit/e436c62792e8c03e9ca154b0a4c722c64bb83269))
* **agents:** M7b vendored playwright-cli and drizzle skills, TanStack Intent, fewer permission prompts ([#33](https://github.com/Crowley-VS/agentic-tanstack/issues/33)) ([cd162c2](https://github.com/Crowley-VS/agentic-tanstack/commit/cd162c2f3315141b5eb029fced1c6165d1a43829))
* **agents:** M7c pnpm db:generate, reviewer and db-migrations subagents, setup-agents, pw:agents, docs/agents.md ([#37](https://github.com/Crowley-VS/agentic-tanstack/issues/37)) ([7f07f5d](https://github.com/Crowley-VS/agentic-tanstack/commit/7f07f5d1c010437de02535eed5d954cc147b2bd0))
* **agents:** review-loop retrospective and round-1-heavy loop with a fix checker ([#3](https://github.com/Crowley-VS/agentic-tanstack/issues/3)) ([4085d3d](https://github.com/Crowley-VS/agentic-tanstack/commit/4085d3d8cc3acf4ece17c7c20cedf605c32acb19))
* **api,logger:** M6c production runtime, API half (JSON logs, APP_VERSION, SIGTERM drain) ([#28](https://github.com/Crowley-VS/agentic-tanstack/issues/28)) ([0d86c63](https://github.com/Crowley-VS/agentic-tanstack/commit/0d86c63ca705f9176ed3740d388aed1a4c9b0ecb))
* **api:** M3a GraphQL API skeleton (Yoga + Pothos, print-schema, tsdown) ([#5](https://github.com/Crowley-VS/agentic-tanstack/issues/5)) ([95055cb](https://github.com/Crowley-VS/agentic-tanstack/commit/95055cb4ece0a9b85f0e7e6e0489e7cfe0078e44))
* **api:** M3b Notes API (queries, mutations via core, costs, READ_ONLY) ([#6](https://github.com/Crowley-VS/agentic-tanstack/issues/6)) ([b2214fd](https://github.com/Crowley-VS/agentic-tanstack/commit/b2214fdabb283c80cd07d4abf8cf615229566c36))
* **api:** M5b shared web/API contract, request log, Query.readOnly, LISTEN_HOST ([#14](https://github.com/Crowley-VS/agentic-tanstack/issues/14)) ([6105f87](https://github.com/Crowley-VS/agentic-tanstack/commit/6105f871d8a1fd45d362e54f1f2d7a0fe2b1e593))
* **db,core:** M2 data layer on Docker Postgres 18 ([#4](https://github.com/Crowley-VS/agentic-tanstack/issues/4)) ([93f3b15](https://github.com/Crowley-VS/agentic-tanstack/commit/93f3b154e2767be488404b69e7f0f64241aa4fa4))
* **deploy:** M6a production images and a prod-like local stack ([#26](https://github.com/Crowley-VS/agentic-tanstack/issues/26)) ([ab5dc48](https://github.com/Crowley-VS/agentic-tanstack/commit/ab5dc483722c5e7a447d647e9d977e798e4a8021))
* **deploy:** M6e Railway infrastructure as code (experimental) ([#30](https://github.com/Crowley-VS/agentic-tanstack/issues/30)) ([52ac476](https://github.com/Crowley-VS/agentic-tanstack/commit/52ac47655d585ece2a58fcc63d5bb51b81589d3b))
* M1 workspace skeleton, agent guardrails and PR review loop ([#1](https://github.com/Crowley-VS/agentic-tanstack/issues/1)) ([d05ab20](https://github.com/Crowley-VS/agentic-tanstack/commit/d05ab2046d30fd38c9ff1b14d7c74e610c4f38a1))
* **ui:** M4d packages/ui (Tailwind 4, shadcn/ui radix-nova) wired into apps/web ([#11](https://github.com/Crowley-VS/agentic-tanstack/issues/11)) ([b764a9f](https://github.com/Crowley-VS/agentic-tanstack/commit/b764a9f6c238058de83f9e066bcd1e0d645d3515))
* **web-e2e,ci:** M6b, the e2e specs against the production images ([#27](https://github.com/Crowley-VS/agentic-tanstack/issues/27)) ([457a44a](https://github.com/Crowley-VS/agentic-tanstack/commit/457a44a553194c81f64ae79b86d76836f661d4fa))
* **web-e2e:** M5e web-e2e (Playwright on the production builds), e2e-ci in CI, loopback serve targets ([#17](https://github.com/Crowley-VS/agentic-tanstack/issues/17)) ([b90dacf](https://github.com/Crowley-VS/agentic-tanstack/commit/b90dacf71c4fa2b3fd4d5b4aacae19d37cc88415))
* **web:** M4c data layer (TanStack Query SSR, GraphQL codegen, execute(), [@graphql-eslint](https://github.com/graphql-eslint)) ([#10](https://github.com/Crowley-VS/agentic-tanstack/issues/10)) ([806224e](https://github.com/Crowley-VS/agentic-tanstack/commit/806224eb63efc0d014e1ec7e641e69d820bfc281))
* **web:** M4e test-browser (Vitest Browser Mode) in pnpm check, Playwright Chromium in CI ([#12](https://github.com/Crowley-VS/agentic-tanstack/issues/12)) ([ec7056b](https://github.com/Crowley-VS/agentic-tanstack/commit/ec7056bd47db2b4d65e69e27a5cfa2ea07c06d7d))
* **web:** M5c web server hardening: BFF forwarding, 502/504, error page, health 405 ([#15](https://github.com/Crowley-VS/agentic-tanstack/issues/15)) ([568af19](https://github.com/Crowley-VS/agentic-tanstack/commit/568af19b77ff56c0489b3efda0195d3cd2ecba40))
* **web:** M5d BFF write rate limit (WRITE_RATE_LIMIT, 429 with Retry-After and RATE_LIMITED) ([#16](https://github.com/Crowley-VS/agentic-tanstack/issues/16)) ([399133f](https://github.com/Crowley-VS/agentic-tanstack/commit/399133f63e267648500908e405acef1ed7928313))
* **web:** M5f notes board: Load more, note page with comments, read-only banner, 404s ([#18](https://github.com/Crowley-VS/agentic-tanstack/issues/18)) ([adab5f6](https://github.com/Crowley-VS/agentic-tanstack/commit/adab5f6281b60c27b4e1fc1824650f46a3762e3b))
* **web:** M5g notes forms: create note, add comment, READ_ONLY and 429 handling ([#19](https://github.com/Crowley-VS/agentic-tanstack/issues/19)) ([412a2a0](https://github.com/Crowley-VS/agentic-tanstack/commit/412a2a0b9c46ab7adb217ade8d9c31216e53d812))
* **web:** M6d production runtime, web half (request log, request ids, version, drain) ([#29](https://github.com/Crowley-VS/agentic-tanstack/issues/29)) ([7916aba](https://github.com/Crowley-VS/agentic-tanstack/commit/7916aba3efbfd71be230d79daeedfeadbba52448))


### Bug Fixes

* **agents:** make the branch-deletion ask rule match `git push <remote> :<branch>` ([#47](https://github.com/Crowley-VS/agentic-tanstack/issues/47)) ([a8f8229](https://github.com/Crowley-VS/agentic-tanstack/commit/a8f82293ed71e888a47b7399cb99c683b8725318))
* **api:** price connection edges per connection, not globally ([#7](https://github.com/Crowley-VS/agentic-tanstack/issues/7)) ([9a99816](https://github.com/Crowley-VS/agentic-tanstack/commit/9a998162360409975a2035fd6de0a5fae6f3cfee))
* **db:** db-up follow-ups from [#32](https://github.com/Crowley-VS/agentic-tanstack/issues/32)'s review (waiters, failures, lock dir, CI gate) ([#34](https://github.com/Crowley-VS/agentic-tanstack/issues/34)) ([79fc15a](https://github.com/Crowley-VS/agentic-tanstack/commit/79fc15ab960022a523e6d72bc873782e5c5bd3f6))
* **db:** serialize concurrent db-up starts and retry transient pull errors ([#32](https://github.com/Crowley-VS/agentic-tanstack/issues/32)) ([990f500](https://github.com/Crowley-VS/agentic-tanstack/commit/990f5004a18f8c90de700f1b44501b9a9993353d))
* **tools,db:** M5 follow-ups for local resources, check-versions and the e2e docs ([#25](https://github.com/Crowley-VS/agentic-tanstack/issues/25)) ([1d677a8](https://github.com/Crowley-VS/agentic-tanstack/commit/1d677a832805ee48a3e50e113f417d24ae7eff25))
* **tools:** run the generated-files gate before the nx step in pnpm check ([#8](https://github.com/Crowley-VS/agentic-tanstack/issues/8)) ([57b73c1](https://github.com/Crowley-VS/agentic-tanstack/commit/57b73c19c44c8d1a7c0ef181698180157bc1558b))
* **tools:** stop resource leaks from agent worktrees (teardown, prune:orphans, NX_USE_LOCAL) ([#22](https://github.com/Crowley-VS/agentic-tanstack/issues/22)) ([1e57885](https://github.com/Crowley-VS/agentic-tanstack/commit/1e578851baae1b1ca1a20e727cba274a15afd209))
* **web,api:** close the M5 review findings in the app (forms, error page, rate limit) ([#24](https://github.com/Crowley-VS/agentic-tanstack/issues/24)) ([f2a5b80](https://github.com/Crowley-VS/agentic-tanstack/commit/f2a5b80b9118b036d7103711e3a0c7db34ae93a4))
* **web:** keep the SIGTERM and drain log lines whole on Railway ([#35](https://github.com/Crowley-VS/agentic-tanstack/issues/35)) ([381aadd](https://github.com/Crowley-VS/agentic-tanstack/commit/381aaddf56c38ff641a4314f9d0aa8ff3feb1ecf))
* **web:** M5a M4 follow-ups: data layer, codegen caching, browser-test and CI hygiene ([#13](https://github.com/Crowley-VS/agentic-tanstack/issues/13)) ([b875f90](https://github.com/Crowley-VS/agentic-tanstack/commit/b875f90eecb7094e8a77b11ed6588baa5c3b23c6))

## 0.0.0

Development before the first release (0.1.0); the history is in git. release-please adds each
release above this heading, which stays as the baseline.
