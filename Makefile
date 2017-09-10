.PHONY: all run clean cleaner minify client server host app fallback

rwildcard=$(foreach d,$(wildcard $1*),$(call rwildcard,$d/,$2) $(filter $(subst *,%,$2),$d))
scripts=$(call rwildcard, $1/, *.tsx) $(call rwildcard, $1/, *.ts)

COMMON_FILES = $(call scripts, common)
CLIENT_FILES = $(call scripts, client)
SERVER_FILES = $(call scripts, server)
HOST_FILES = $(call scripts, host)
SRC_FILES = $(call scripts, src)

all: host server client fallback app
minify: public/client.min.js public/fallback.min.js all

run: all
	node --trace-warnings --inspect build/host/index.js

clean:
	rm -rf public/{client,fallback,app}{,.min}.js api/ {common,host,client,src}/*.js build/

cleaner: clean
	rm -rf node_modules
	pushd preact && npm run-script clean


node_modules/typescript/bin/tsc: package.json
	npm install && touch node_modules/typescript/bin/tsc


preact/package.json: .gitmodules
	git submodule update --init --recursive preact && touch preact/package.json

preact/dist/preact.js: preact/package.json
	pushd preact && npm install

node_modules/preact/dist/preact.d.ts: preact/src/preact.d.ts preact/dist/preact.js
	pushd preact && npm run copy-typescript-definition

node_modules/preact: node_modules/typescript/bin/tsc preact/dist/preact.js
	mkdir -p node_modules
	pushd node_modules && ln -sf ../preact/ preact


api/:
	mkdir -p api


host: build/index.js

build/index.js: $(HOST_FILES) $(COMMON_FILES) types/concurrence-types.d.ts tsconfig-host.json node_modules/typescript/bin/tsc
	node_modules/typescript/bin/tsc -p tsconfig-host.json


server: build/src/app.js

build/src/app.js: $(SERVER_FILES) $(CLIENT_FILES) $(COMMON_FILES) api/ types/*.d.ts tsconfig-server.json node_modules/typescript/bin/tsc node_modules/preact node_modules/preact/dist/preact.d.ts
	node_modules/typescript/bin/tsc -p tsconfig-server.json


client: public/client.js

api/concurrence.d.ts: $(CLIENT_FILES) $(COMMON_FILES) api/ types/*.d.ts tsconfig-client.json node_modules/typescript/bin/tsc node_modules/preact node_modules/preact/dist/preact.d.ts
	node_modules/typescript/bin/tsc -p tsconfig-client.json

public/client.js: api/concurrence.d.ts src/app.js
	rollup -c

fallback: public/fallback.js

public/fallback.js: concurrence-fallback.ts types/*.d.ts tsconfig-fallback.json node_modules/typescript/bin/tsc
	node_modules/typescript/bin/tsc -p tsconfig-fallback.json


app: src/app.js

src/app.js: $(SRC_FILES) api/concurrence.d.ts types/*.d.ts tsconfig-app.json node_modules/typescript/bin/tsc node_modules/preact node_modules/preact/dist/preact.d.ts
	node_modules/typescript/bin/tsc -p tsconfig-app.json


%.min.js: %.js Makefile
	node ./node_modules/google-closure-compiler-js/cmd.js --languageIn ES5 --languageOut ES3 --assumeFunctionWrapper true --rewritePolyfills false $< > $@
