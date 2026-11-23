# Reference dates for test/check-storecrs.mjs, made with cftime:
#   python3 test/make-cftime-fixture.py > test/fixtures/cftime.json
# CF time values on every calendar CF defines, from reference dates before
# year 1 to after 2100, across leap days, month ends and the 1582 change
# from the Julian to the Gregorian calendar, written to the second.
import json, random, cftime, warnings

warnings.simplefilter("ignore")  # cftime warns of year 0 on the real-world calendars
random.seed(8857)
calendars = ["standard", "gregorian", "proleptic_gregorian", "julian", "noleap", "365_day", "all_leap", "366_day", "360_day"]
units = [
    "days since 1850-01-01", "hours since 1850-01-16 12:00:00.000000", "days since 0001-01-01 00:00:00",
    "seconds since 1970-01-01", "minutes since 2000-02-29 06:30", "days since 1582-10-15", "days since 1582-10-04",
    "hours since 1500-03-01", "days since -0100-06-15", "days since 2101-12-31 23:59:59",
]
spans = {"seconds": 86400 * 366 * 300, "minutes": 1440 * 366 * 300, "hours": 24 * 366 * 600, "days": 366 * 2500}
out = {"source": "cftime " + cftime.__version__, "cases": []}
for cal in calendars:
    for u in units:
        if cal in ("noleap", "365_day") and "02-29" in u:
            continue
        span = spans[u.split()[0]]
        xs = [0, 1, -1, 59, 60, 365, 366, -365, -366] + [random.randint(-span, span) for _ in range(6)]
        xs += [random.uniform(-span, span) for _ in range(3)]
        unit, ref = u.split(" since ")
        for x in xs:
            # to the nearest second, as the page gives it
            try:
                d = cftime.num2date(round(x * {"seconds": 1, "minutes": 60, "hours": 3600, "days": 86400}[unit]), "seconds since " + ref, calendar=cal)
            except ValueError:
                continue
            out["cases"].append([x, u, cal, [d.year, d.month, d.day, d.hour, d.minute, d.second]])
print(json.dumps(out))
