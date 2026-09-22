# LLM recommendation verification protocol — 2026-09-22

Scope: no paid model requests. Test the exact default recommendation path used by LLM prompts; downstream choices are a recommendation-following proxy, not a real model. Both arms include the same corrected route accounting and advisory candidate policy. Thus this isolates forecast and first-win-floor changes, not the total effect versus the pre-fix build.

Stage A: legacy versus source-v2 with the existing calibrated opportunity parameters. 16 new seeds 6200001–6200016, 4 fixed opponent panels in contiguous groups of 4, all four focal seats, complete four-round east matches with score carry. 64 paired matches, same deals and opponent policies in both arms. Freeze configs before measuring.

Stage B (separate): retain the selected stage-A forecast; compare existing first-win floors 40/20/10 versus 0/0/0 on new seeds 6200101–6200116 under the same protocol. Only run after stage A has a verdict; an inconclusive A keeps legacy.

Admission: complete all planned pairs without illegal actions, leaked hands, stalled games or score errors; mean seed-averaged paired net > 0 and stratified paired bootstrap 95% lower bound > 0 (5000 resamples); first-place rate does not decrease; net <= -1000 rate increases by at most 1/64. Warm alternating paired function timings over at most 192 distinct public views: candidate P95 <= 1.5 * control P95. Same sample count and thresholds in each stage; no extra sampling or parameter tuning after seeing results. Maximum 10 minutes per stage; hitting the budget means insufficient evidence and no promotion.

These small offline panels are an engineering/strategy adoption gate on fixed proxy opponents, not evidence of actual LLM playing-strength improvement. Stage-specific results do not establish the benefits of unrelated candidate/prompt changes. Critical replay windows are regression fixtures, never holdout samples. No hidden wall or opponent hands enter policy inputs.
