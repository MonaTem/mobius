.PHONY: all run clean cleaner minify server app fallback

rwildcard=$(foreach d,$(wildcard $1*),$(call rwildcard,$d/,$2) $(filter $(subst *,%,$2),$d))
scripts=$(call rwildcard, $1/, *.tsx) $(call rwildcard, $1/, *.ts)

all: host fallback
minify: build/fallback.min.js all

run: all
	node --trace-warnings --inspect build/host/index.js --base sample-app

clean:
	rm -rf api/ build/ types/host/

cleaner: clean
	rm -rf node_modules


host: build/host/index.js

api/server:
	mkdir -p api/server

build/.host/:
	mkdir -p build/.host

build/.host/host/index.js: $(call scripts, host) $(call scripts, common) api/server build/.host/ types/*.d.ts tsconfig-host.json
	node_modules/.bin/tsc -p tsconfig-host.json

build/host/index.js: build/.host/host/index.js
	node_modules/.bin/babel build/.host/ --out-dir build/
	chmod +x build/host/index.js


fallback: build/fallback.js

build/:
	mkdir -p build/

build/diff-match-patch.js: build/
	grep -v module.exports node_modules/diff-match-patch/index.js > $@

build/fallback.js: mobius-fallback.ts build/diff-match-patch.js types/*.d.ts tsconfig-fallback.json build/
	node_modules/.bin/tsc -p tsconfig-fallback.json


%.min.js: %.js Makefile
	node node_modules/.bin/google-closure-compiler-js --languageIn ES5 --languageOut ES3 --assumeFunctionWrapper true --rewritePolyfills false $< > $@
