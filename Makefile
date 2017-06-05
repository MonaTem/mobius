.PHONY: all run clean cleaner

rwildcard=$(foreach d,$(wildcard $1*),$(call rwildcard,$d/,$2) $(filter $(subst *,%,$2),$d))

BOTH_FILES = $(call rwildcard, src/, *.ts) $(call rwildcard, src/, *.js)
CLIENT_FILES = $(call rwildcard, client/, *.ts) $(call rwildcard, client/, *.js)
SERVER_FILES = $(call rwildcard, server/, *.ts) $(call rwildcard, server/, *.js)

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

public/client.js: $(BOTH_FILES) $(CLIENT_FILES) tsconfig-client.json node_modules
	node_modules/typescript/bin/tsc -p tsconfig-client.json

build/server.js: $(BOTH_FILES) $(SERVER_FILES) tsconfig-server.json node_modules
	node_modules/typescript/bin/tsc -p tsconfig-server.json

build/index.js: $(HOST_FILES) src/concurrence.d.ts tsconfig-host.json node_modules
	node_modules/typescript/bin/tsc -p tsconfig-host.json
