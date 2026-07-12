#!/usr/bin/env bash
# verify.sh — Portal MM Solutions
# Contrato: exit 0 = OK, exit 1 = Claude vê e corrige.

ERRORS=0
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT" || { echo "[verify] Erro: não consigo acessar $ROOT"; exit 1; }

echo "[verify] Iniciando — Portal MM Solutions"

if grep -qE '"test"\s*:' "$ROOT/package.json" 2>/dev/null; then
  echo "[verify] ▶ npm test"
  npm test --silent 2>&1 || { echo "[verify] ✗ npm test falhou"; ERRORS=$((ERRORS+1)); }
fi

if [[ $ERRORS -gt 0 ]]; then
  echo "[verify] ✗ $ERRORS verificação(ões) falharam"
  exit 1
fi
echo "[verify] ✓ tudo OK"
