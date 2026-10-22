// 合成测试用：在被测模块加载前禁止创建任何子进程。用法：node --import ./tests/helpers/block-all-processes.mjs --test ...
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';

for (const name of ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork']) {
  childProcess[name] = () => {
    throw new Error('PROCESS CREATION BLOCKED BY SYNTHETIC TEST GUARD');
  };
}
syncBuiltinESMExports();
