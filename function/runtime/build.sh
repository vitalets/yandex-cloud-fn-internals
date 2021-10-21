#!/bin/bash

set -e

runtimeFolder=/function/runtime
codeFolder=/function/code

packageJson="${codeFolder}/package.json"
packageLockJson="${codeFolder}/package-lock.json"

if test -f "$packageJson"; then
  export LD_LIBRARY_PATH="${runtimeFolder}/lib"
  export PATH="${codeFolder}:${codeFolder}/bin:${runtimeFolder}/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"
  export HOME="${codeFolder}"
  cd ${codeFolder}

  echo "===> package.json found in sources"
  if test -f "$packageLockJson"; then
    echo "===> package-lock.json found in sources"
    echo "===> will start 'npm ci' in $codeFolder"
    /function/runtime/bin/npm ci --production
    echo "===> done with 'npm ci' in $codeFolder"
  else
    echo "===> will start 'npm install' in $codeFolder"
    /function/runtime/bin/npm install --production
    echo "===> done with 'npm install' in $codeFolder"
  fi
else
  echo "===> no package.json found in sources, nothing to build"
fi