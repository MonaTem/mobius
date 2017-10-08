// Force main "mobius" module to load first so that it can intercept any forms of non-determinism
import * as mobius from "mobius";
import * as app from "app";
mobius;
app;
