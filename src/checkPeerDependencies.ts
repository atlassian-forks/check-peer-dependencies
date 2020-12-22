#!/usr/bin/env node
import * as semver from 'semver';

import { exec } from 'shelljs';
import { CliOptions } from './cli';
import { getCommandLines } from './packageManager';
import { Dependency, gatherPeerDependencies, getInstalledVersion, isSameDep } from './packageUtils';
import { findPossibleResolutions, Resolution } from './solution';

function getAllNestedPeerDependencies(options: CliOptions): Dependency[] {
  const gatheredDependencies = gatherPeerDependencies(".", options);

  function applySemverInformation(dep: Dependency): Dependency {
    const installedVersion = getInstalledVersion(dep);
    const semverSatisfies = installedVersion ? semver.satisfies(installedVersion, dep.version) : false;
    const isYalc = !!/-[a-f0-9]+-yalc$/.exec(installedVersion);

    return { ...dep, installedVersion, semverSatisfies, isYalc };
  }

  return gatheredDependencies.map(applySemverInformation);
}

let recursiveCount = 0;

const reportPeerDependencyStatusByDepender = (dep: Dependency, options: CliOptions) => {
  if (dep.semverSatisfies) {
    if (options.verbose) {
      console.log(`  ✅  ${dep.depender}@${dep.dependerVersion} requires ${dep.name} ${dep.version} (${dep.installedVersion} is installed)`);
    }
  } else if (dep.isYalc) {
    console.log(`  ☑️  ${dep.depender}@${dep.dependerVersion} requires ${dep.name} ${dep.version} (${dep.installedVersion} is installed via yalc)`);
  } else if (dep.installedVersion) {
    console.log(`  ❌  ${dep.depender}@${dep.dependerVersion} requires ${dep.name} ${dep.version} (${dep.installedVersion} is installed)`);
  } else {
    console.log(`  ❌  ${dep.depender}@${dep.dependerVersion} requires ${dep.name} ${dep.version} (${dep.name} is not installed)`);
  }
};

const reportPeerDependencyStatusByDependee = (dep: Dependency, options: CliOptions) => {
  if (dep.semverSatisfies) {
    if (options.verbose) {
      console.log(`  ✅  ${dep.name} ${dep.version} is required by ${dep.depender}@${dep.dependerVersion} (${dep.installedVersion} is installed)`);
    }
  } else if (dep.isYalc) {
    console.log(`  ☑️  ${dep.name} ${dep.version} is required by ${dep.depender}@${dep.dependerVersion} (${dep.installedVersion} is installed via yalc)`);
  } else if (dep.installedVersion) {
    console.log(`  ❌  ${dep.name} ${dep.version} is required by ${dep.depender}@${dep.dependerVersion} (${dep.installedVersion} is installed)`);
  } else {
    console.log(`  ❌  ${dep.name} ${dep.version} is required by ${dep.depender}@${dep.dependerVersion} (${dep.name} is not installed)`);
  }
};


function findSolutions(problems: Dependency[], allNestedPeerDependencies: Dependency[]) {
  console.log();
  console.log('Searching for solutions...');
  console.log();
  const resolutions: Resolution[] = findPossibleResolutions(problems, allNestedPeerDependencies);
  const resolutionsWithSolutions = resolutions.filter(r => r.resolution);
  const nosolution = resolutions.filter(r => !r.resolution);

  nosolution.forEach(solution => {
    const name = solution.problem.name;
    const errorPrefix = `Unable to find a version of ${name} that satisfies the following peerDependencies:`;
    const peerDepRanges = allNestedPeerDependencies.filter(dep => dep.name === name)
        .reduce((acc, dep) => acc.includes(dep.version) ? acc : acc.concat(dep.version), []);
    console.error(`  ❌  ${errorPrefix} ${peerDepRanges.join(" and ")}`)
  });


  if (nosolution.length > 0) {
    console.error();
  }

  return { resolutionsWithSolutions, nosolution };
}

function installPeerDependencies(commandLines: any[], options: CliOptions, nosolution: Resolution[], packageManager: string) {
  console.log('Installing peerDependencies...');
  console.log();
  commandLines.forEach(command => {
    console.log(`$ ${command}`);
    exec(command);
    console.log();
  });

  const newUnsatisfiedDeps = getAllNestedPeerDependencies(options)
      .filter(dep => !dep.semverSatisfies)
      .filter(dep => !nosolution.some(x => isSameDep(x.problem, dep)));

  if (nosolution.length === 0 && newUnsatisfiedDeps.length === 0) {
    console.log('All peer dependencies are met');
  }

  if (newUnsatisfiedDeps.length > 0) {
    console.log(`Found ${newUnsatisfiedDeps.length} new unmet peerDependencies...`);
    if (++recursiveCount < 5) {
      return checkPeerDependencies(packageManager, options);
    } else {
      console.error('Recursion limit reached (5)');
      process.exit(5)
    }
  }
  return;
}

export function checkPeerDependencies(packageManager: string, options: CliOptions) {
  const allNestedPeerDependencies = getAllNestedPeerDependencies(options);

  if (options.orderBy === 'depender') {
    allNestedPeerDependencies.sort((a, b) => `${a.depender}${a.name}`.localeCompare(`${b.depender}${b.name}`));
    allNestedPeerDependencies.forEach(dep => reportPeerDependencyStatusByDepender(dep, options));
  } else if (options.orderBy === 'dependee') {
    allNestedPeerDependencies.sort((a, b) => `${a.name}${a.depender}`.localeCompare(`${b.name}${b.depender}`));
    allNestedPeerDependencies.forEach(dep => reportPeerDependencyStatusByDependee(dep, options));
  }

  const problems = allNestedPeerDependencies.filter(dep => !dep.semverSatisfies && !dep.isYalc);

  if (!problems.length) {
    console.log('  ✅  All peer dependencies are met');
    return;
  }

  if (options.install) {
    const { nosolution, resolutionsWithSolutions } = findSolutions(problems, allNestedPeerDependencies);
    const commandLines = getCommandLines(packageManager, resolutionsWithSolutions);

    if (commandLines.length) {
      return installPeerDependencies(commandLines, options, nosolution, packageManager);
    }
  } else if (options.findSolutions) {
    const { resolutionsWithSolutions } = findSolutions(problems, allNestedPeerDependencies);
    const commandLines = getCommandLines(packageManager, resolutionsWithSolutions);

    if (commandLines.length) {
      console.log(`Install peerDependencies using ${commandLines.length > 1 ? 'these commands:' : 'this command'}:`);
      console.log();
      commandLines.forEach(command => console.log(command));
      console.log();
    }
  } else {
    console.log(`Install peerDependencies using "npx check-peer-dependencies --install"`);
  }

  process.exit(1);
}
