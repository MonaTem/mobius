.PHONY: all run clean cleaner minify server app fallback

rwildcard=$(foreach d,$(wildcard $1*),$(call rwildcard,$d/,$2) $(filter $(subst *,%,$2),$d))
scripts=$(call rwildcard, $1/, *.tsx) $(call rwildcard, $1/, *.ts)

all: host fallback dist/common/preact.js
minify: dist/fallback.min.js all

run: all
	node --trace-warnings --inspect dist/mobius.js --base sample-app

clean:
	rm -rf dist/ .rpt2_cache/

cleaner: clean
	rm -rf node_modules


dist/common/:
	mkdir -p $@

node_modules/preact/dist/preact.d.ts:
	# Global tools that preact requires be available
	npm install -g npm-run-all rollup babel-cli jscodeshift gzip-size-cli rimraf
	pushd node_modules/preact && npm version --allow-same-version 0.0.1 && npm install

dist/common/preact.js: dist/common/ node_modules/preact/dist/preact.d.ts
	cp node_modules/preact/dist/preact.d.ts dist/common/
	cp node_modules/preact/dist/preact.esm.js dist/common/preact.js


host: dist/mobius.js

dist/.host/:
	mkdir -p mobius/.host

dist/.host/mobius.js: $(call scripts, host) $(call scripts, common) mobius.ts dist/.host/ types/*.d.ts tsconfig-host.json
	node_modules/.bin/tsc -p tsconfig-host.json

dist/mobius.js: dist/.host/mobius.js
	node_modules/.bin/babel dist/.host/ --out-dir dist/
	chmod +x dist/mobius.js


fallback: dist/fallback.js

dist/:
	mkdir -p dist/

dist/diff-match-patch.js: dist/
	grep -v module.exports node_modules/diff-match-patch/index.js > $@

dist/fallback.js: mobius-fallback.ts dist/diff-match-patch.js types/*.d.ts tsconfig-fallback.json dist/
	node_modules/.bin/tsc -p tsconfig-fallback.json


%.min.js: %.js Makefile
	node node_modules/.bin/google-closure-compiler-js --languageIn ES5 --languageOut ES3 --assumeFunctionWrapper true --rewritePolyfills false $< > $@
