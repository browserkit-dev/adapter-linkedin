.PHONY: agent-check build test lint

# Run before declaring any task done.
# Builds, then runs all unit + harness tests (no browser, no network).
agent-check: build test
	@echo "✓ agent-check passed"

build:
	npx tsc

test:
	npx vitest run

lint:
	npx tsc --noEmit
