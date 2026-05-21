#!/bin/bash
# /opt/erstat/run-scrape.sh
#
# Wrapper invoked by cron every 5 min. Sources the shared env file, runs the
# top-level scrape.js which iterates all enabled providers, writes one JSON
# summary line per provider to the log.
#
# Replaces the older run-ns-closures.sh (which only ran NSH). You can delete
# the old wrapper after this one's verified working.

set -a
source /opt/erstat/.env
set +a

cd /opt/erstat/provincial_disruption_tracker
/usr/bin/node scrape.js >> /opt/erstat/logs/provincial-scrape.log 2>&1
