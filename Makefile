.PHONY: all run clean cleaner minify

rwildcard=$(foreach d,$(wildcard $1*),$(call rwildcard,$d/,$2) $(filter $(subst *,%,$2),$d))

API_FILES = $(call rwildcard, api/, *.ts) $(call rwildcard, api/, *.js) $(call rwildcard, api/, *.tsx) $(call rwildcard, api/, *.jsx) $(call rwildcard, src/, *.ts) $(call rwildcard, src/, *.js) $(call rwildcard, src/, *.tsx) $(call rwildcard, src/, *.jsx)
CLIENT_FILES = $(filter-out $(call rwildcard, api/, *-server.ts) $(call rwildcard, api/, *-server.js) $(call rwildcard, api/, *-server.tsx) $(call rwildcard, api/, *-server.jsx), $(API_FILES))
SERVER_FILES = $(filter-out $(call rwildcard, api/, *-client.ts) $(call rwildcard, api/, *-client.js) $(call rwildcard, api/, *-client.tsx) $(call rwildcard, api/, *-client.jsx), $(API_FILES))
HOST_FILES = $(call rwildcard, host/, *.ts) $(call rwildcard, host/, *.js)


all: public/client.js public/fallback.js build/server.js build/index.js
minify: public/client.min.js public/fallback.min.js build/server.js build/index.js

run: all
	node --trace-warnings --inspect build/index.js

clean:
	rm -rf public/client{,.min}.js public/fallback{,.min}.js build/

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


public/client.js: $(CLIENT_FILES) tsconfig-client.json node_modules/typescript/bin/tsc node_modules/preact node_modules/preact/dist/preact.d.ts
	node_modules/typescript/bin/tsc -p tsconfig-client.json

public/fallback.js: concurrence-fallback.ts tsconfig-fallback.json node_modules/typescript/bin/tsc
	node_modules/typescript/bin/tsc -p tsconfig-fallback.json

build/server.js: $(SERVER_FILES) tsconfig-server.json node_modules/typescript/bin/tsc node_modules/preact node_modules/preact/dist/preact.d.ts
	node_modules/typescript/bin/tsc -p tsconfig-server.json

build/index.js: $(HOST_FILES) api/concurrence.d.ts tsconfig-host.json node_modules/typescript/bin/tsc
	node_modules/typescript/bin/tsc -p tsconfig-host.json


%.min.js: %.js
	node ./node_modules/google-closure-compiler-js/cmd.js --languageIn ES5 --languageOut ES3 --assumeFunctionWrapper true $< > $@
