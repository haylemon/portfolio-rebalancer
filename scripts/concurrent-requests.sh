#!/bin/bash
# Simulates concurrent HTTP requests against the running API server.
# Demonstrates duplicate job prevention, SKIP LOCKED behaviour, and
# correct state under parallel load.
#
# Prerequisites:
#   - API server running:  npm run dev
#   - Worker running:      npm run worker
#   - jq installed:        brew install jq
#
# Usage: bash scripts/concurrent-requests.sh <portfolio-id>

set -e

PORTFOLIO_ID="${1}"
BASE_URL="http://localhost:3000"

if [ -z "$PORTFOLIO_ID" ]; then
  echo "Usage: bash scripts/concurrent-requests.sh <portfolio-id>"
  exit 1
fi

echo ""
echo "========================================"
echo "  Concurrency Simulation"
echo "========================================"
echo "Portfolio: $PORTFOLIO_ID"
echo ""


# -------------------------------------------------------
# SCENARIO 1: Duplicate rebalance prevention
# Fire 5 rebalance requests simultaneously.
# Only 1 should succeed (202). The other 4 should get 409.
# -------------------------------------------------------
echo "--- Scenario 1: 5 simultaneous rebalance requests ---"
echo "Expected: 1 x 202 Accepted, 4 x 409 Conflict"
echo ""

# Wait for any existing job to clear first
sleep 5

for i in 1 2 3 4 5; do
  curl -s -o /tmp/rebalance_result_${i}.json \
       -w "%{http_code}" \
       -X POST "${BASE_URL}/portfolios/${PORTFOLIO_ID}/rebalance" &
done

# Collect results
wait
echo "HTTP status codes received:"
for i in 1 2 3 4 5; do
  STATUS=$(cat /tmp/rebalance_result_${i}.json | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('job',{}).get('status','conflict'))" 2>/dev/null || echo "conflict")
  CODE=$(cat /tmp/rebalance_result_${i}.json | python3 -c "import sys,json; d=json.load(sys.stdin); print('202' if 'job' in d else '409')" 2>/dev/null || echo "?")
  echo "  Request ${i}: ${CODE}"
done
echo ""


# -------------------------------------------------------
# SCENARIO 2: Concurrent deposits
# Fire 10 deposits of $100 simultaneously.
# Final cash balance should increase by exactly $1000.
# -------------------------------------------------------
echo "--- Scenario 2: 10 simultaneous deposits of \$100 ---"

# Get starting balance
START_BALANCE=$(curl -s "${BASE_URL}/portfolios/${PORTFOLIO_ID}" | python3 -c "import sys,json; print(json.load(sys.stdin)['cash_balance'])")
echo "Starting cash_balance: \$${START_BALANCE}"
echo "Expected increase: \$1000"
echo ""

for i in $(seq 1 10); do
  curl -s -X POST "${BASE_URL}/portfolios/${PORTFOLIO_ID}/deposit" \
       -H "Content-Type: application/json" \
       -d '{"amount": 100}' > /dev/null &
done
wait

END_BALANCE=$(curl -s "${BASE_URL}/portfolios/${PORTFOLIO_ID}" | python3 -c "import sys,json; print(json.load(sys.stdin)['cash_balance'])")
ACTUAL_INCREASE=$(python3 -c "print(round(${END_BALANCE} - ${START_BALANCE}, 2))")

echo "Ending cash_balance:  \$${END_BALANCE}"
echo "Actual increase:      \$${ACTUAL_INCREASE}"

if [ "$ACTUAL_INCREASE" = "1000.0" ] || [ "$ACTUAL_INCREASE" = "1000" ] || [ "$ACTUAL_INCREASE" = "1000.00" ]; then
  echo "✓ All 10 deposits applied correctly — no lost updates"
else
  echo "✗ Mismatch — expected \$1000 increase, got \$${ACTUAL_INCREASE}"
fi
echo ""


# -------------------------------------------------------
# SCENARIO 3: Out-of-order price updates
# Send a newer price, then an older price for the same symbol.
# The older one should be rejected (409) — we keep the newer.
# -------------------------------------------------------
echo "--- Scenario 3: Out-of-order price updates ---"
echo "Sending newer price first, then older price for AAPL"
echo ""

curl -s -X POST "${BASE_URL}/prices/AAPL" \
     -H "Content-Type: application/json" \
     -d "{\"price\": 175.00, \"as_of\": \"2024-01-01T12:00:00Z\"}" \
     | python3 -c "import sys,json; d=json.load(sys.stdin); print(f'  Newer price (12:00): HTTP status implied by response — price={d.get(\"price\",\"rejected\")}, updated_at={d.get(\"updated_at\",\"N/A\")[:19] if d.get(\"updated_at\") else \"N/A\"}')"

curl -s -X POST "${BASE_URL}/prices/AAPL" \
     -H "Content-Type: application/json" \
     -d "{\"price\": 150.00, \"as_of\": \"2024-01-01T11:00:00Z\"}" \
     | python3 -c "import sys,json; d=json.load(sys.stdin); print(f'  Older price (11:00): {d.get(\"error\",\"accepted — this is wrong!\")}')"

CURRENT_PRICE=$(curl -s "${BASE_URL}/prices" | python3 -c "import sys,json; prices={p['symbol']:p['price'] for p in json.load(sys.stdin)}; print(prices.get('AAPL','not found'))")
echo "  Current AAPL price: \$${CURRENT_PRICE} (should be 175.00)"
echo ""


# -------------------------------------------------------
# Show final job list
# -------------------------------------------------------
echo "--- Current job queue ---"
curl -s "${BASE_URL}/jobs" | python3 -c "
import sys, json
jobs = json.load(sys.stdin)
for j in jobs[:5]:
    print(f'  {j[\"id\"][:8]}... | {j[\"status\"]:10} | attempts={j[\"attempts\"]}')
"

echo ""
echo "========================================"
echo "  Simulation complete"
echo "========================================"
