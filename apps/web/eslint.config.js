import base from "@lomi/config/eslint";
import globals from "globals";

export default [...base, { languageOptions: { globals: { ...globals.browser } } }];
