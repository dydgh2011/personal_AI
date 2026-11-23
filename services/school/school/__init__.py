"""School connector service: reads Quercus, Piazza, UofT mail (forwarded to Gmail) and public course
sites with the owner's credentials, keeps every item as an original in the knowledge store, and tells
the owner about important news right away and the rest in digests.

Credentials stay in this container only. Hermes reaches the results through hermes-broker
(read-only routes); it never sees a token or password.
"""
