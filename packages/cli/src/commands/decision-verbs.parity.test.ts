import { argvLine } from '../testing/argv-case';
import { writeCases } from '../testing/writes';

writeCases(
  import.meta.url,
  [
    ...(['records', 'table', 'ids', 'json', 'jsonl'] as const).map((format) =>
      argvLine(
        `decide "Where?" --option Here --option There --recommend 1 --class architecture -p MMR --task MMR-3 -f ${format}`,
      ),
    ),
    argvLine('decide "Where?" --option Here --recommend 1 --class product -p MMR'),
    argvLine('update MMR-q1 --task MMR-4'),
    argvLine('update MMR-q1 --untask MMR-3'),
    argvLine('update MMR-q1 --title Wrong'),
    ...['--agreement Terms', '--clear-agreement', '--time-cap 20'].flatMap((flag) => [
      argvLine(`update MMR-q1 ${flag}`),
      argvLine(`update MMR-q1 ${flag} --task MMR-4`),
    ]),
    ...['promote', 'resolve', 'reject', 'archive', 'unarchive'].map((verb) =>
      argvLine(`${verb} MMR-q1`),
    ),
    ...['promote', 'resolve', 'reject'].map((verb) => argvLine(`${verb} MMR-d1`)),
    argvLine('update MMR-q1'),
    argvLine('get MMR-q1 -f json'),
    argvLine('get MMR-3 -f json'),
    argvLine('confirm MMR-q1 -f jsonl'),
    argvLine('overturn MMR-q1 --option 2 -f jsonl'),
    argvLine('confirm MMR-q1 "Accepted" -f json'),
    argvLine('overturn MMR-q1 --option 2 "Move" -f json'),
    argvLine('overturn MMR-q1 "Neither"'),
    argvLine('overturn MMR-q1 --option 1'),
  ],
  async (board) => {
    await board.engine.decide({
      class: 'architecture',
      options: ['Here', 'There'],
      project: 'MMR',
      question: 'Where?',
      recommended: 1,
      tasks: ['MMR-3'],
    });
  },
);
