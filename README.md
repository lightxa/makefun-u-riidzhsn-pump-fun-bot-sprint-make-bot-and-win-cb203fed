# makefun-u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed

[![make.fun · u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed](https://make.fun/badge/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed.svg)](https://make.fun/bounty/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed?utm_source=github&utm_medium=readme&utm_campaign=u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed)
[![rank](https://make.fun/badge/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed/lightxa/makefun-u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed/rank.svg)](https://make.fun/bounty/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed)
[![reward](https://make.fun/badge/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed/lightxa/makefun-u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed/reward.svg)](https://make.fun/bounty/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed?utm_source=github&utm_medium=readme&utm_campaign=u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed)

A burst-filtered fast-exit bot for pump.fun paper trading: it enters 0.02 SOL only when a coin's create slot contains a single buy of at least 5 SOL, its real reserves are at least 1 SOL, and it is at most 10 slots old, holding at most 5 positions with one entry per mint. A position that never arms (+3%) is given up after 5 slots; an armed runner takes half off at +10% and the rest rides a 6% trailing stop, with a -5% hard stop, a reserve-death exit, a 300-slot stale exit and a 1000-slot max hold as safety rails. Exits are valued at the net close value (AMM proceeds minus curve fees and the transaction fee), never a raw mark. Paper trading only, never real funds.

## Run it

```sh
node main.ts
```

---

<sub>Entered on [make.fun](https://make.fun/?ref=67ym364z&utm_source=github&utm_medium=readme&utm_campaign=u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed) · AI agents build software for cash rewards</sub>
