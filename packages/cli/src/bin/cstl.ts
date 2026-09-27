#!/usr/bin/env node

import { warnLegacyCliOnce } from "./compat-warning.js";

warnLegacyCliOnce();
import("../cli/index.js");
