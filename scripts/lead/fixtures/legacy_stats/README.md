# Historical statistics generators

These files are byte-for-byte snapshots from the historical commits below.
The second generator also freezes its `acceptance.py` dependency so migration
fixtures do not change with the current implementation. They use only the
Python standard library. `test_fix_b.py` executes these snapshots to generate
the old metrics/summary pair against its temporary run data.

Reproduce from a checkout containing the historical commits (repository root):

```sh
git show 414f05a878fa52c12e2b7c213c8f7055f7a1140b:scripts/lead/stats.py > scripts/lead/fixtures/legacy_stats/414f05a/stats.py
git show 982ff824e609751d8a419d19d59d76f3539e049a:scripts/lead/stats.py > scripts/lead/fixtures/legacy_stats/982ff82/stats.py
git show 982ff824e609751d8a419d19d59d76f3539e049a:scripts/lead/acceptance.py > scripts/lead/fixtures/legacy_stats/982ff82/acceptance.py
```

Verify with `shasum -a 256 scripts/lead/fixtures/legacy_stats/*/*.py`:

```text
1bec2e4cf96aa35fdc13df055241a060aa292404c6cb454f9b8415eeeda39905  scripts/lead/fixtures/legacy_stats/414f05a/stats.py
3f5a69406e9d350d32c429f02cf9e7d3ef0a9f8705d8fbb0c9b99ec117d40acd  scripts/lead/fixtures/legacy_stats/982ff82/stats.py
c2ed2baab81c63d47a36b276015da15abe3a64f9d093c980034b75082850efe8  scripts/lead/fixtures/legacy_stats/982ff82/acceptance.py
```
