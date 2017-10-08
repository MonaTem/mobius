.PHONY: all run clean cleaner minify client server app fallback

rwildcard=$(foreach d,$(wildcard $1*),$(call rwildcard,$d/,$2) $(filter $(subst *,%,$2),$d))
scripts=$(call rwildcard, $1/, *.tsx) $(call rwildcard, $1/, *.ts)

COMMON_FILES = $(call scripts, common)
CLIENT_FILES = $(call scripts, client)
SERVER_FILES = $(call scripts, server)
HOST_FILES = $(call scripts, host)
SRC_FILES = $(call scripts, src)

all: server client fallback app
minify: build/src/client.min.js build/fallback.min.js all

run: all
	node --trace-warnings --inspect build/host/index.js

clean:
	rm -rf api/ build/ types/host/

cleaner: clean
	rm -rf node_modules


node_modules: package.json
	mkdir -p node_modules && touch node_modules
	npm install

node_modules/preact/dist/preact.js: node_modules
	# Global tools that preact requires be available
	npm install -g npm-run-all rollup babel-cli jscodeshift gzip-size-cli rimraf
	pushd node_modules/preact && npm install

server: build/src/app.js

api/server:
	mkdir -p api/server

build/.server/:
	mkdir -p build/.server

build/.server/src/app.js: $(SRC_FILES) $(SERVER_FILES) $(HOST_FILES) $(COMMON_FILES) api/server build/.server/ types/*.d.ts tsconfig-server.json node_modules node_modules/preact/dist/preact.js
	node_modules/.bin/tsc -p tsconfig-server.json

build/src/app.js: build/.server/src/app.js
	node_modules/.bin/babel build/.server/ --out-dir build/
	chmod +x build/host/index.js


client: build/.client/client/mobius.js

api/client:
	mkdir -p api/client

build/.client/:
	mkdir -p build/.client

build/.client/client/mobius.js: $(CLIENT_FILES) $(COMMON_FILES) api/client build/.client types/*.d.ts tsconfig-client.json node_modules node_modules/preact/dist/preact.js
	node_modules/.bin/tsc -p tsconfig-client.json


fallback: build/fallback.js

build/:
	mkdir -p build/

build/diff-match-patch.js: node_modules build/
	grep -v module.exports node_modules/diff-match-patch/index.js > $@

build/fallback.js: mobius-fallback.ts build/diff-match-patch.js types/*.d.ts tsconfig-fallback.json node_modules build/
	node_modules/.bin/tsc -p tsconfig-fallback.json


app: build/.client/src/app.js

build/.client/src/app.js: $(SRC_FILES) $(SERVER_FILES) $(COMMON_FILES) build/.client/client/mobius.js types/*.d.ts tsconfig-app.json node_modules node_modules/preact/dist/preact.js
	node_modules/.bin/tsc -p tsconfig-app.json


%.min.js: %.js Makefile
	node node_modules/.bin/google-closure-compiler-js --languageIn ES5 --languageOut ES3 --assumeFunctionWrapper true --rewritePolyfills false $< > $@
