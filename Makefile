.PHONY: all run clean cleaner

rwildcard=$(foreach d,$(wildcard $1*),$(call rwildcard,$d/,$2) $(filter $(subst *,%,$2),$d))

API_FILES = $(call rwildcard, api/, *.ts) $(call rwildcard, api/, *.js) $(call rwildcard, src/, *.ts) $(call rwildcard, src/, *.js)
HOST_FILES = $(call rwildcard, host/, *.ts) $(call rwildcard, host/, *.js)

all: public/client.js build/server.js build/index.js

run: all
	node --trace-warnings build/index.js

clean:
	rm -rf public/client.js build/

cleaner: clean
	rm -rf node_modules

node_modules: package.json
	npm install

public/client.js: $(API_FILES) tsconfig-client.json node_modules
	node_modules/typescript/bin/tsc -p tsconfig-client.json

build/server.js: $(API_FILES) tsconfig-server.json node_modules
	node_modules/typescript/bin/tsc -p tsconfig-server.json

build/index.js: $(HOST_FILES) api/concurrence.d.ts tsconfig-host.json node_modules
	node_modules/typescript/bin/tsc -p tsconfig-host.json
