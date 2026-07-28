# ExperimCarteSco1D — conventions

Application statique en 3 fichiers : `dataviz.html` (structure), `dataviz.js`
(logique), `dataviz.css` (styles). Pas de build.

## Version affichée dans la signature

Le pied du volet gauche (`#app-version` dans `dataviz.html`, ex.
`DSDEN 82 [ExperimCarteSco v1.75]`) affiche une version du widget. Ce n'est
**pas** calculé automatiquement au chargement — c'est une chaîne codée en
dur qui doit être mise à jour manuellement.

**Convention : à chaque commit qui modifie `dataviz.html`, `dataviz.js` ou
`dataviz.css`, recalculer et mettre à jour cette version dans le même
commit.**

Format : `ExperimCarteSco v1.N`, où N = nombre total de commits touchant ces
3 fichiers, en comptant le commit en cours (pas de division par 10 : la page
reste en version majeure 1 tant qu'il n'y a pas eu de changement majeur
d'ergonomie ou de fonctions).

```bash
git log --oneline -- ExperimCarteSco1D/dataviz.html ExperimCarteSco1D/dataviz.js ExperimCarteSco1D/dataviz.css | wc -l
```

Exemple : 74 commits avant le commit courant → ce commit est le 75e →
`ExperimCarteSco v1.75`.
