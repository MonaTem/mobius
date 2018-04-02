.PHONY: all run clean cleaner host fallback preact lint test

rwildcard=$(foreach d,$(wildcard $1*),$(call rwildcard,$d/,$2) $(filter $(subst *,%,$2),$d))
scripts=$(call rwildcard, $1/, *.tsx) $(call rwildcard, $1/, *.ts)

all: host fallback preact

run: all
	node --trace-warnings --inspect dist/mobius.js --base ../mobius-sample --source-map --workers 2

clean:
	rm -rf dist/ mobius-*.tgz

cleaner: clean
	rm -rf node_modules

lint:
	node_modules/.bin/tslint -c tslint.json 'host/**/*.ts' 'common/**/*.ts' 'server/**/*.ts' 'client/**/*.ts' mobius.ts --fix

test: lint
	# TODO: Add actual tests

preact: dist/common/preact.js dist/common/preact.d.ts

dist/common/:
	mkdir -p $@

node_modules/preact/dist/preact.esm.js: $(call rwildcard, node_modules/preact/src/, *.js)
	# Global tools that preact requires be available
	npm install -g npm-run-all rollup babel-cli jscodeshift gzip-size-cli rimraf
	cd node_modules/preact && npm version --allow-same-version 0.0.1 && npm install && npm run-script transpile

dist/common/preact.js: node_modules/preact/dist/preact.esm.js dist/common/
	cp $< $@

dist/common/preact.d.ts: node_modules/preact/src/preact.d.ts dist/common/
	cp $< $@


host: dist/mobius.js

dist/mobius.js: $(call scripts, host) $(call scripts, common) mobius.ts types/*.d.ts tsconfig-host.json
	node_modules/.bin/tsc -p tsconfig-host.json
	chmod +x dist/mobius.js


fallback: dist/fallback.min.js

dist/:
	mkdir -p dist/

dist/diff-match-patch.js: dist/
	grep -v module.exports node_modules/diff-match-patch/index.js > $@

dist/fallback.js: mobius-fallback.ts dist/diff-match-patch.js types/*.d.ts tsconfig-fallback.json dist/
	node_modules/.bin/tsc -p tsconfig-fallback.json

dist/fallback.min.js: dist/fallback.js
	node_modules/.bin/google-closure-compiler-js --languageOut ES3 --jsCode $< > $@
