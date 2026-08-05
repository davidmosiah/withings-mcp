# Empty export warning

`buildCollectionOutput` sets `empty: true` and a `warning` string when a list/export returns zero rows.
Markdown channel also surfaces the warning so agents do not treat empty as success.
