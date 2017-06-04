.PHONY: all run clean cleaner

rwildcard=$(foreach d,$(wildcard $1*),$(call rwildcard,$d/,$2) $(filter $(subst *,%,$2),$d))

BOTH_FILES = $(call rwildcard, src/, *.ts) $(call rwildcard, src/, *.js)
CLIENT_FILES = $(call rwildcard, client/, *.ts) $(call rwildcard, client/, *.js)
SERVER_FILES = $(call rwildcard, server/, *.ts) $(call rwildcard, server/, *.js)

all: public/client.js server.js

run: all
	node --trace-warnings index.js

clean:
	rm -f server.js public/client.js

cleaner: clean
	rm -rf node_modules

node_modules: package.json
	npm install

server.js: $(BOTH_FILES) $(SERVER_FILES) tsconfig-server.json node_modules
	node_modules/typescript/bin/tsc -p tsconfig-server.json

public/client.js: $(BOTH_FILES) $(CLIENT_FILES) tsconfig-client.json node_modules
	node_modules/typescript/bin/tsc -p tsconfig-client.json

