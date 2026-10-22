# ZS5 soak report

- start: 2026-10-22T15:45:11.849Z
- end: 2026-10-22T16:15:11.852Z
- duration_s: 1800
- samples: 180
- csv_rows: 1080

## Verdict

| criterion                                                 | value                | pass     |
| --------------------------------------------------------- | -------------------- | -------- |
| memory ratio (last 10min mean <= first 10min mean * 1.25) | see table            | true     |
| scratch electron process count (last <= first + 1)        | first=6 last=6 max=6 | true     |
| crash dir new files                                       | 0                    | true     |
| **OVERALL**                                               |                      | **PASS** |

## Memory (per pid mean WS)

| pid   | name         | first10min MB | last10min MB | ratio | result |
| ----- | ------------ | ------------- | ------------ | ----- | ------ |
| 45776 | electron.exe | 158.7         | 161.6        | 1.018 | PASS   |
| 508   | electron.exe | 196.1         | 183.4        | 0.935 | PASS   |
| 26956 | electron.exe | 59.2          | 59.2         | 1.000 | PASS   |
| 69516 | electron.exe | 210.9         | 208.5        | 0.989 | PASS   |
| 9104  | electron.exe | 124.1         | 122.4        | 0.986 | PASS   |
| 28408 | electron.exe | 119.7         | 118.6        | 0.990 | PASS   |

## Process count curve (per 10s sample)

first=6 last=6 max=6 samples=180

## Crash directory check

baseline files: 0
final files: 0
new files: (none)
