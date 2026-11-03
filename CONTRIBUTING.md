<!-- A lawyer should review this file, CLA.md and LICENSE before outside contributions are accepted. -->

# Contributing to Tricot

Thanks for helping. Two things first.

## The licence, and your contribution

Tricot's core and command line are open source under the [GNU Affero General Public License, version 3](LICENSE), and Tricot Studio also offers them under a [commercial licence](COMMERCIAL.md) to anyone who can't meet the AGPL. So that the Licensor can offer both, every contribution needs the [Contributor Licence Agreement](CLA.md): You keep your copyright and give the Licensor the right to relicense Your contribution, commercially included. Read it, then comment "I have read the CLA and I agree to it" on Your first pull request. A pull request without that can't be merged.

## Working on the code

The source is at https://github.com/TricotStudio/tricot. Fork it there and send changes as pull requests.

```sh
git clone https://github.com/TricotStudio/tricot.git
cd tricot
npm install
npm test            # the tests
npm run typecheck
npm run dev         # the board on http://127.0.0.1:4545, with the web UI reloading
```

Use a scratch port and data folder for anything you try by hand, so you don't touch your own boards:

```sh
PORT=4610 TRICOT_DATA_DIR=$(mktemp -d) npm start
```

Report a bug or suggest a change in the [issues](https://github.com/TricotStudio/tricot/issues). Open one before a large change, so we agree on the direction first.
