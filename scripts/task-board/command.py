"""Offline task-board command used by Crew CLI and MCP; no service or model starts."""
import argparse
import json
import sqlite3
import sys

from server import BoardStore


class CommandParser(argparse.ArgumentParser):
    def error(self, message):
        raise ValueError(message)


def main(argv=None):
    parser = CommandParser(description=__doc__)
    parser.add_argument('--workspace', required=True)
    parser.add_argument('--manifest', required=True)
    parser.add_argument('--action', required=True, choices=('list', 'get', 'cancel', 'status'))
    parser.add_argument('--task', type=int)
    parser.add_argument('--expected-status')
    parser.add_argument('--note')
    try:
        args = parser.parse_args(argv)
        store = BoardStore(args.workspace, args.manifest)
        if args.action == 'list':
            result = store.view()
        elif args.action == 'get':
            result = store.get(args.task)
        elif args.action == 'status':
            result = store.status(args.task)
        else:
            result = store.cancel(args.task, args.expected_status, args.note)
        print(json.dumps(result, ensure_ascii=False))
        return 0
    except (OSError, ValueError, KeyError, TypeError, sqlite3.Error) as error:
        print(str(error), file=sys.stderr)
        return 1


if __name__ == '__main__':
    sys.exit(main())
