#!/bin/bash
cd "$1"
diff -q <( node ../../dist/mobius.js --replay test ) expected.txt
