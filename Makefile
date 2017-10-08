.PHONY: all run clean cleaner minify server app fallback

rwildcard=$(foreach d,$(wildcard $1*),$(call rwildcard,$d/,$2) $(filter $(subst *,%,$2),$d))
scripts=$(call rwildcard, $1/, *.tsx) $(call rwildcard, $1/, *.ts)

COMMON_FILES = $(call scripts, common)
SERVER_FILES = $(call scripts, server)
HOST_FILES = $(call scripts, host)
SRC_FILES = $(call scripts, src)

all: server fallback
minify: build/fallback.min.js all

run: all
	node --trace-warnings --inspect build/host/index.js

clean:
	rm -rf api/ build/ types/host/

cleaner: clean
	rm -rf node_modules


server: build/src/app.js

api/server:
	mkdir -p api/server

build/.server/:
	mkdir -p build/.server

build/.server/src/app.js: $(SRC_FILES) $(SERVER_FILES) $(HOST_FILES) $(COMMON_FILES) api/server build/.server/ types/*.d.ts tsconfig-server.json
	node_modules/.bin/tsc -p tsconfig-server.json

build/src/app.js: build/.server/src/app.js
	node_modules/.bin/babel build/.server/ --out-dir build/
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
