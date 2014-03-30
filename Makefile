BIN = ./node_modules/.bin/
NODE ?= node
SRC = $(shell find lib -name "*.js")
BUILD = $(subst lib,build,$(SRC))

build:
	@mkdir -p build/builders build/plugins
	@$(MAKE) $(BUILD)

build/%.js: lib/%.js
	@$(BIN)regenerator --include-runtime $< > $@

clean:
	@rm -rf build

test:
	@$(NODE) $(BIN)mocha \
		--harmony-generators \
		--require should \
		--reporter spec \
		--timeout 10s \
		--bail \
		test/scripts.js \
		test/styles.js

.PHONY: test clean